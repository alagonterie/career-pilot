/**
 * Integration test (Layer 3) for the career-pilot delivery action
 * handlers. Exercises the full host-side round-trip — handler reads its
 * payload, hits central `data/v2.db` (here :memory:), writes a response
 * back to a session's inbound.db — without spawning a container.
 *
 * Mirrors what the host's delivery sweep would do when the container's
 * MCP tool writes a system action to outbound.db. Catches regressions in
 * SQL, UPSERT branching, obfuscated_label generation, response framing.
 *
 * Separate from the pure-function tests in `actions.test.ts` which
 * cover helpers (encodeSuffix, slugify, deriveIndustry) in isolation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  handleCreateGmailDraft,
  handleGetApplication,
  handleListApplications,
  handleRecordFunnelEvent,
  handleUpdateApplication,
  handleUpdateProfileField,
} from './actions.js';

// ── Setup ──────────────────────────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'test-session-1',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-26T00:00:00Z',
};

let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  // Fresh in-memory central DB + freshly-truncated session inbound DB per
  // test. This keeps obfuscated_label sequencing deterministic (each test
  // starts from `<industry>-a`).
  closeDb();
  const db = initTestDb();
  runMigrations(db);

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

interface ResponseFrame<T = Record<string, unknown>> {
  type: string;
  requestId: string;
  frame: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}

function actionContent(
  action: string,
  payload: Record<string, unknown>,
): {
  action: string;
  requestId: string;
  payload: Record<string, unknown>;
} {
  return { action, requestId: `req-${Math.random().toString(36).slice(2, 10)}`, payload };
}

function readResponse(requestId: string): ResponseFrame {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return JSON.parse(row.content) as ResponseFrame;
}

// ── update_profile_field ───────────────────────────────────────────────────

describe('handleUpdateProfileField', () => {
  it('UPSERTs a row when none exists, then UPDATEs in place', async () => {
    const c1 = actionContent('career_pilot.update_profile_field', { field: 'full_name', value: 'Jane Doe' });
    await handleUpdateProfileField(c1, FAKE_SESSION, inDb);

    const resp1 = readResponse(c1.requestId);
    expect(resp1.frame.ok).toBe(true);

    const row1 = getDb().prepare('SELECT full_name, target_roles FROM candidate_profile WHERE id = 1').get() as {
      full_name: string;
      target_roles: string | null;
    };
    expect(row1.full_name).toBe('Jane Doe');
    expect(row1.target_roles).toBeNull();

    const c2 = actionContent('career_pilot.update_profile_field', {
      field: 'target_roles',
      value: '["Staff Backend"]',
    });
    await handleUpdateProfileField(c2, FAKE_SESSION, inDb);

    const row2 = getDb().prepare('SELECT full_name, target_roles FROM candidate_profile WHERE id = 1').get() as {
      full_name: string;
      target_roles: string;
    };
    expect(row2.full_name).toBe('Jane Doe'); // preserved
    expect(row2.target_roles).toBe('["Staff Backend"]'); // updated
  });

  it('returns BAD_FIELD for unknown field name', async () => {
    const c = actionContent('career_pilot.update_profile_field', { field: 'not_a_real_column', value: 'x' });
    await handleUpdateProfileField(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('BAD_FIELD');
    }
  });
});

// ── update_application (UPSERT) ────────────────────────────────────────────

describe('handleUpdateApplication', () => {
  it('INSERTs on first call with required fields, assigns obfuscated_label', async () => {
    const c = actionContent('career_pilot.update_application', {
      id: 'app-1',
      patch: { company_name: 'Acme', role_title: 'Staff Backend', status: 'BOOKMARKED' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      const data = resp.frame.data as { id: string; created: boolean; obfuscated_label: string };
      expect(data.created).toBe(true);
      expect(data.id).toBe('app-1');
      expect(data.obfuscated_label).toBe('misc-a'); // no jd_analyzed → 'misc' industry
    }

    const row = getDb()
      .prepare('SELECT company_name, role_title, status, obfuscated_label FROM applications WHERE id = ?')
      .get('app-1') as Record<string, unknown>;
    expect(row.company_name).toBe('Acme');
    expect(row.status).toBe('BOOKMARKED');
    expect(row.obfuscated_label).toBe('misc-a');
  });

  it('rejects INSERT when required fields are missing', async () => {
    const c = actionContent('career_pilot.update_application', {
      id: 'app-missing',
      patch: { company_name: 'Acme' }, // missing role_title + status
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('BAD_ARGS');
      expect(resp.frame.error.message).toMatch(/role_title.*status|status.*role_title/);
    }

    const exists = getDb().prepare('SELECT 1 FROM applications WHERE id = ?').get('app-missing');
    expect(exists).toBeUndefined();
  });

  it('UPDATEs in-place on subsequent calls, preserves obfuscated_label', async () => {
    const c1 = actionContent('career_pilot.update_application', {
      id: 'app-2',
      patch: { company_name: 'Acme', role_title: 'Backend', status: 'BOOKMARKED' },
    });
    await handleUpdateApplication(c1, FAKE_SESSION, inDb);

    const c2 = actionContent('career_pilot.update_application', {
      id: 'app-2',
      patch: { status: 'APPLIED', applied_at: '2026-05-26T10:00:00Z' },
    });
    await handleUpdateApplication(c2, FAKE_SESSION, inDb);

    const resp = readResponse(c2.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      const data = resp.frame.data as { created: boolean; obfuscated_label: string };
      expect(data.created).toBe(false);
      expect(data.obfuscated_label).toBe('misc-a'); // label preserved from INSERT
    }

    const row = getDb()
      .prepare('SELECT company_name, status, applied_at FROM applications WHERE id = ?')
      .get('app-2') as Record<string, unknown>;
    expect(row.company_name).toBe('Acme'); // preserved
    expect(row.status).toBe('APPLIED'); // updated
    expect(row.applied_at).toBe('2026-05-26T10:00:00Z');
  });

  it('uses jd_analyzed.role_category for obfuscated_label industry slug', async () => {
    const c1 = actionContent('career_pilot.update_application', {
      id: 'fintech-1',
      patch: {
        company_name: 'Stripe',
        role_title: 'Platform',
        status: 'BOOKMARKED',
        jd_analyzed: JSON.stringify({ role_category: 'fintech', level: 'Staff' }),
      },
    });
    await handleUpdateApplication(c1, FAKE_SESSION, inDb);

    const resp = readResponse(c1.requestId);
    if (resp.frame.ok) {
      const data = resp.frame.data as { obfuscated_label: string };
      expect(data.obfuscated_label).toBe('fintech-a');
    }

    const c2 = actionContent('career_pilot.update_application', {
      id: 'fintech-2',
      patch: {
        company_name: 'Plaid',
        role_title: 'Backend',
        status: 'BOOKMARKED',
        jd_analyzed: JSON.stringify({ role_category: 'fintech' }),
      },
    });
    await handleUpdateApplication(c2, FAKE_SESSION, inDb);

    const resp2 = readResponse(c2.requestId);
    if (resp2.frame.ok) {
      const data = resp2.frame.data as { obfuscated_label: string };
      expect(data.obfuscated_label).toBe('fintech-b'); // next letter in series
    }
  });
});

// ── update_application → §24.11 resanitization hook ─────────────────────────

describe('handleUpdateApplication — §24.11 resanitization hook', () => {
  // Seed an obfuscated application + one funnel event mentioning the real
  // company name. The mirror runs via handleRecordFunnelEvent's own hook, so
  // after this helper there is exactly one redacted public_audit_trail row.
  async function seedObfuscatedAppWithEvent(note = 'jane wrote on behalf of Acme Corp'): Promise<string> {
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-r',
        patch: { company_name: 'Acme Corp', role_title: 'Backend', status: 'APPLIED' },
      }),
      FAKE_SESSION,
      inDb,
    );
    const label = (
      getDb().prepare("SELECT obfuscated_label FROM applications WHERE id = 'app-r'").get() as {
        obfuscated_label: string;
      }
    ).obfuscated_label;
    await handleRecordFunnelEvent(
      actionContent('career_pilot.record_funnel_event', {
        application_id: 'app-r',
        kind: 'recruiter_email',
        payload: { note },
      }),
      FAKE_SESSION,
      inDb,
    );
    return label;
  }

  it('fires on a public_state change, rewriting the audit row to the real name', async () => {
    const label = await seedObfuscatedAppWithEvent();

    const before = getDb().prepare('SELECT application_ref, summary FROM public_audit_trail').get() as {
      application_ref: string;
      summary: string;
    };
    expect(before.summary).toContain(`[REDACTED:${label}]`);
    expect(before.summary).not.toContain('Acme Corp');

    const c = actionContent('career_pilot.update_application', {
      id: 'app-r',
      patch: { public_state: 'public' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const rows = getDb().prepare('SELECT application_ref, summary FROM public_audit_trail').all() as {
      application_ref: string;
      summary: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].application_ref).toBe('Acme Corp');
    expect(rows[0].summary).toContain('Acme Corp');
    expect(rows[0].summary).not.toContain(`[REDACTED:${label}]`);
  });

  it('fires on a company_aliases change, redacting the newly-known alias', async () => {
    const label = await seedObfuscatedAppWithEvent('AcmeCo recruiter pinged me');

    let row = getDb().prepare('SELECT summary FROM public_audit_trail').get() as { summary: string };
    expect(row.summary).toContain('AcmeCo'); // alias unknown at write time → leaked

    const c = actionContent('career_pilot.update_application', {
      id: 'app-r',
      patch: { company_aliases: '["AcmeCo"]' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    row = getDb().prepare('SELECT summary FROM public_audit_trail').get() as { summary: string };
    expect(row.summary).toContain(`[REDACTED:${label}]`);
    expect(row.summary).not.toContain('AcmeCo');
  });

  it('does NOT fire on a non-trigger field change (status)', async () => {
    const label = await seedObfuscatedAppWithEvent();
    const before = getDb().prepare('SELECT id, summary FROM public_audit_trail').get() as {
      id: string;
      summary: string;
    };

    const c = actionContent('career_pilot.update_application', {
      id: 'app-r',
      patch: { status: 'PHONE_SCREEN' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const after = getDb().prepare('SELECT id, summary FROM public_audit_trail').all() as {
      id: string;
      summary: string;
    }[];
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id); // same row — no delete+reinsert
    expect(after[0].summary).toBe(before.summary);
    expect(after[0].summary).toContain(`[REDACTED:${label}]`);
  });

  it('does NOT fire when the resanitize preference is off, but still persists the UPDATE', async () => {
    const label = await seedObfuscatedAppWithEvent();
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at)
         VALUES ('sanitization_resanitize_on_application_update', 'false', '2026-05-28T00:00:00Z')`,
      )
      .run();
    const before = getDb().prepare('SELECT id, summary FROM public_audit_trail').get() as {
      id: string;
      summary: string;
    };

    const c = actionContent('career_pilot.update_application', {
      id: 'app-r',
      patch: { public_state: 'public' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    // Application IS updated...
    const app = getDb().prepare("SELECT public_state FROM applications WHERE id = 'app-r'").get() as {
      public_state: string;
    };
    expect(app.public_state).toBe('public');
    // ...but the audit row was NOT rewritten.
    const after = getDb().prepare('SELECT id, summary FROM public_audit_trail').all() as {
      id: string;
      summary: string;
    }[];
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].summary).toContain(`[REDACTED:${label}]`);
  });

  it('keeps audit count == funnel_events count across an update then a new event', async () => {
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-r',
        patch: { company_name: 'Acme Corp', role_title: 'Backend', status: 'APPLIED' },
      }),
      FAKE_SESSION,
      inDb,
    );
    // Event 1 (obfuscated → redacted audit row).
    await handleRecordFunnelEvent(
      actionContent('career_pilot.record_funnel_event', {
        application_id: 'app-r',
        kind: 'recruiter_email',
        payload: { note: 'first from Acme Corp' },
      }),
      FAKE_SESSION,
      inDb,
    );
    // Flip to public — resanitize rewrites event 1's row.
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', { id: 'app-r', patch: { public_state: 'public' } }),
      FAKE_SESSION,
      inDb,
    );
    // Event 2 (mirrors as public).
    await handleRecordFunnelEvent(
      actionContent('career_pilot.record_funnel_event', {
        application_id: 'app-r',
        kind: 'recruiter_email',
        payload: { note: 'second from Acme Corp' },
      }),
      FAKE_SESSION,
      inDb,
    );

    const eventCount = (
      getDb().prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE application_id = 'app-r'").get() as {
        n: number;
      }
    ).n;
    const auditCount = (getDb().prepare('SELECT COUNT(*) AS n FROM public_audit_trail').get() as { n: number }).n;
    expect(eventCount).toBe(2);
    expect(auditCount).toBe(2); // no duplicates, no drops
    const rows = getDb().prepare('SELECT summary FROM public_audit_trail').all() as { summary: string }[];
    for (const r of rows) expect(r.summary).toContain('Acme Corp');
  });

  it('does not roll back the UPDATE if resanitization fails', async () => {
    await seedObfuscatedAppWithEvent();
    // Force the resanitize transaction to throw by removing its target table.
    // The function catches internally and the handler wraps it in try/catch,
    // so the already-committed UPDATE must survive and the response stays ok.
    getDb().exec('DROP TABLE public_audit_trail');

    const c = actionContent('career_pilot.update_application', {
      id: 'app-r',
      patch: { public_state: 'public' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);

    expect(readResponse(c.requestId).frame.ok).toBe(true);
    const app = getDb().prepare("SELECT public_state FROM applications WHERE id = 'app-r'").get() as {
      public_state: string;
    };
    expect(app.public_state).toBe('public');
  });

  it('end-to-end: 3 events through the handlers, then a public_state flip rewrites all 3', async () => {
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-r',
        patch: { company_name: 'Acme Corp', role_title: 'Backend', status: 'APPLIED' },
      }),
      FAKE_SESSION,
      inDb,
    );
    const label = (
      getDb().prepare("SELECT obfuscated_label FROM applications WHERE id = 'app-r'").get() as {
        obfuscated_label: string;
      }
    ).obfuscated_label;

    for (const note of ['first call with Acme Corp', 'second note from Acme Corp', 'third Acme Corp update']) {
      await handleRecordFunnelEvent(
        actionContent('career_pilot.record_funnel_event', {
          application_id: 'app-r',
          kind: 'recruiter_email',
          payload: { note },
        }),
        FAKE_SESSION,
        inDb,
      );
    }

    // All 3 mirrored while obfuscated → redacted.
    const before = getDb().prepare('SELECT summary FROM public_audit_trail').all() as { summary: string }[];
    expect(before).toHaveLength(3);
    for (const r of before) {
      expect(r.summary).toContain(`[REDACTED:${label}]`);
      expect(r.summary).not.toContain('Acme Corp');
    }

    // Flip to public through the handler → all 3 rewritten with the real name.
    const c = actionContent('career_pilot.update_application', {
      id: 'app-r',
      patch: { public_state: 'public' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const after = getDb().prepare('SELECT application_ref, summary FROM public_audit_trail').all() as {
      application_ref: string;
      summary: string;
    }[];
    expect(after).toHaveLength(3);
    for (const r of after) {
      expect(r.application_ref).toBe('Acme Corp');
      expect(r.summary).toContain('Acme Corp');
      expect(r.summary).not.toContain(`[REDACTED:${label}]`);
    }
  });
});

// ── record_funnel_event ────────────────────────────────────────────────────

describe('handleRecordFunnelEvent', () => {
  beforeEach(async () => {
    // Seed an application so funnel_events FK resolves.
    const c = actionContent('career_pilot.update_application', {
      id: 'app-funnel',
      patch: { company_name: 'Acme', role_title: 'Backend', status: 'BOOKMARKED' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
  });

  it('INSERTs a funnel event row + bumps last_activity_at', async () => {
    const before = (
      getDb().prepare('SELECT last_activity_at FROM applications WHERE id = ?').get('app-funnel') as {
        last_activity_at: string;
      }
    ).last_activity_at;

    // Give it a tick so the timestamp comparison is observable.
    await new Promise((r) => setTimeout(r, 50));

    const c = actionContent('career_pilot.record_funnel_event', {
      application_id: 'app-funnel',
      kind: 'status_change',
      from_status: 'BOOKMARKED',
      to_status: 'APPLIED',
      payload: { summary: 'submitted application', source: 'candidate_message' },
    });
    await handleRecordFunnelEvent(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      const data = resp.frame.data as { event_id: string };
      expect(data.event_id).toMatch(/^fe-/);
    }

    const event = getDb().prepare('SELECT * FROM funnel_events WHERE application_id = ?').get('app-funnel') as Record<
      string,
      unknown
    >;
    expect(event.kind).toBe('status_change');
    expect(event.from_status).toBe('BOOKMARKED');
    expect(event.to_status).toBe('APPLIED');
    expect(event.source).toBe('agent');

    const after = (
      getDb().prepare('SELECT last_activity_at FROM applications WHERE id = ?').get('app-funnel') as {
        last_activity_at: string;
      }
    ).last_activity_at;
    expect(after).not.toBe(before); // bumped
  });

  it('returns NOT_FOUND when application_id does not exist', async () => {
    const c = actionContent('career_pilot.record_funnel_event', {
      application_id: 'ghost-app',
      kind: 'status_change',
      payload: { summary: 'nope' },
    });
    await handleRecordFunnelEvent(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('NOT_FOUND');
    }
  });

  it('mirrors a sanitized row to public_audit_trail (Phase 4 §24.10 spot check)', async () => {
    // Override the seeded app's obfuscated_label so the spot check is
    // deterministic regardless of how update_application sequenced labels.
    getDb()
      .prepare(`UPDATE applications SET company_name = 'Acme Corp', obfuscated_label = 'fintech-a' WHERE id = ?`)
      .run('app-funnel');

    const c = actionContent('career_pilot.record_funnel_event', {
      application_id: 'app-funnel',
      kind: 'recruiter_email',
      payload: {
        note: 'jane@acme.com from Acme Corp wrote about the $220k offer',
      },
    });
    await handleRecordFunnelEvent(c, FAKE_SESSION, inDb);

    // Action response is ok and references the new event_id.
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);

    // Private write preserves the truth.
    const privateRow = getDb()
      .prepare(`SELECT payload FROM funnel_events WHERE application_id = 'app-funnel' AND kind = 'recruiter_email'`)
      .get() as { payload: string } | undefined;
    expect(privateRow).toBeDefined();
    expect(privateRow!.payload).toContain('Acme Corp');
    expect(privateRow!.payload).toContain('jane@acme.com');
    expect(privateRow!.payload).toContain('$220k');

    // Public mirror lands sanitized.
    const publicRow = getDb().prepare(`SELECT application_ref, summary, category FROM public_audit_trail`).get() as
      | { application_ref: string; summary: string; category: string }
      | undefined;
    expect(publicRow).toBeDefined();
    expect(publicRow!.application_ref).toBe('fintech-a');
    expect(publicRow!.category).toBe('funnel');
    expect(publicRow!.summary).toContain('[REDACTED:fintech-a]');
    expect(publicRow!.summary).toContain('[EMAIL_REDACTED]');
    expect(publicRow!.summary).toContain('[AMOUNT_REDACTED]');
    expect(publicRow!.summary).not.toContain('Acme Corp');
    expect(publicRow!.summary).not.toContain('jane@acme.com');
    expect(publicRow!.summary).not.toContain('$220k');
  });
});

// ── get_application / list_applications ────────────────────────────────────

describe('handleGetApplication + handleListApplications', () => {
  beforeEach(async () => {
    // Seed two apps with different statuses.
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-a',
        patch: { company_name: 'Acme', role_title: 'Backend', status: 'BOOKMARKED' },
      }),
      FAKE_SESSION,
      inDb,
    );
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-b',
        patch: { company_name: 'Beta', role_title: 'Platform', status: 'APPLIED' },
      }),
      FAKE_SESSION,
      inDb,
    );
  });

  it('get_application returns the row when it exists', async () => {
    const c = actionContent('career_pilot.get_application', { id: 'app-a' });
    await handleGetApplication(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      const data = resp.frame.data as { application: Record<string, unknown> | null };
      expect(data.application).not.toBeNull();
      expect(data.application!.company_name).toBe('Acme');
    }
  });

  it('get_application returns null for missing id', async () => {
    const c = actionContent('career_pilot.get_application', { id: 'ghost' });
    await handleGetApplication(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    if (resp.frame.ok) {
      const data = resp.frame.data as { application: Record<string, unknown> | null };
      expect(data.application).toBeNull();
    }
  });

  it('list_applications returns all rows without filter', async () => {
    const c = actionContent('career_pilot.list_applications', {});
    await handleListApplications(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    if (resp.frame.ok) {
      const data = resp.frame.data as { applications: Array<Record<string, unknown>> };
      expect(data.applications).toHaveLength(2);
    }
  });

  it('list_applications filters by status', async () => {
    const c = actionContent('career_pilot.list_applications', { status: 'APPLIED' });
    await handleListApplications(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    if (resp.frame.ok) {
      const data = resp.frame.data as { applications: Array<Record<string, unknown>> };
      expect(data.applications).toHaveLength(1);
      expect(data.applications[0].company_name).toBe('Beta');
    }
  });

  it('list_applications respects limit', async () => {
    const c = actionContent('career_pilot.list_applications', { limit: 1 });
    await handleListApplications(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    if (resp.frame.ok) {
      const data = resp.frame.data as { applications: Array<Record<string, unknown>> };
      expect(data.applications).toHaveLength(1);
    }
  });
});

// ── create_gmail_draft ─────────────────────────────────────────────────────

// Phase 2.3 sandbox-isolation smoke test (closes DoD #8). The handler
// refuses any session whose agent_group_id resolves to a folder !==
// 'career-pilot'. Verified by seeding both groups + flipping the session
// agent_group_id between them.

const OWNER_SESSION: Session = {
  ...FAKE_SESSION,
  id: 'sess-owner',
  agent_group_id: 'ag-owner',
};
const SANDBOX_SESSION: Session = {
  ...FAKE_SESSION,
  id: 'sess-sandbox',
  agent_group_id: 'ag-sandbox',
};

function seedAgentGroups(): void {
  createAgentGroup({
    id: 'ag-owner',
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-05-27T00:00:00Z',
  });
  createAgentGroup({
    id: 'ag-sandbox',
    name: 'Career Pilot Sandbox',
    folder: 'career-pilot-sandbox',
    agent_provider: null,
    created_at: '2026-05-27T00:00:00Z',
  });
}

describe('handleCreateGmailDraft', () => {
  let originalGmailStub: string | undefined;

  beforeEach(() => {
    seedAgentGroups();
    originalGmailStub = process.env.GMAIL_STUB;
  });

  afterAll(() => {
    if (originalGmailStub === undefined) {
      delete process.env.GMAIL_STUB;
    } else {
      process.env.GMAIL_STUB = originalGmailStub;
    }
  });

  it('returns stub draft_id in GMAIL_STUB=1 mode for owner session', async () => {
    process.env.GMAIL_STUB = '1';
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'jane.doe@example.com',
      subject: 'Test subject line',
      body: 'Hi Jane, test outreach body content.',
    });
    await handleCreateGmailDraft(c, OWNER_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      const data = resp.frame.data as { draft_id: string; draft_url: string; stub: boolean };
      expect(data.stub).toBe(true);
      expect(data.draft_id).toMatch(/^stub-draft-/);
      expect(data.draft_url).toContain(data.draft_id);
    }
  });

  it('refuses with FORBIDDEN when session belongs to sandbox group (DoD #8)', async () => {
    process.env.GMAIL_STUB = '1';
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'jane.doe@example.com',
      subject: 'Test subject',
      body: 'Test body',
    });
    await handleCreateGmailDraft(c, SANDBOX_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('FORBIDDEN');
      expect(resp.frame.error.message).toMatch(/sandbox/i);
    }
  });

  it('returns NOT_IMPLEMENTED when GMAIL_STUB is not set (real Gmail path is Phase 3+)', async () => {
    delete process.env.GMAIL_STUB;
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'jane.doe@example.com',
      subject: 'Test',
      body: 'Body',
    });
    await handleCreateGmailDraft(c, OWNER_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('NOT_IMPLEMENTED');
    }
  });

  it('rejects invalid email with BAD_ARGS', async () => {
    process.env.GMAIL_STUB = '1';
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'not-an-email',
      subject: 'Test',
      body: 'Body',
    });
    await handleCreateGmailDraft(c, OWNER_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('BAD_ARGS');
    }
  });

  it('rejects empty body with BAD_ARGS', async () => {
    process.env.GMAIL_STUB = '1';
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'jane@example.com',
      subject: 'Test',
      body: '',
    });
    await handleCreateGmailDraft(c, OWNER_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) {
      expect(resp.frame.error.code).toBe('BAD_ARGS');
    }
  });
});
