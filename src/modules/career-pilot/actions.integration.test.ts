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
import { ensureSchema, insertMessage, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  handleCreateGmailDraft,
  handleEmitColdEmail,
  handleEmitTailoredResume,
  handleGetApplication,
  handleListApplications,
  handleRecordDispatch,
  handleRecordPipelineEvent,
  handleRecordProgress,
  handleRecordRequestTelemetry,
  handleRecordTurnTelemetry,
  handleSetPreference,
  handleSetWorkProfile,
  handleUpdateApplication,
  handleUpdateProfileField,
  PROGRESS_PER_SESSION_CAP,
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

/**
 * Seed a wake (`trigger=1`) message of the given kind into the session
 * inbound DB so `deriveProactive(inDb)` classifies the current turn (§24.24).
 * `chat`/`chat-sdk` → reactive; `task`/`webhook`/`system` → proactive.
 */
function seedWake(kind: string): void {
  insertMessage(inDb, {
    id: `wake-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: '{}',
    processAfter: null,
    recurrence: null,
    trigger: 1,
  });
}

// ── emit_tailored_resume (§24.144) ─────────────────────────────────────────

describe('handleEmitTailoredResume', () => {
  it('rejects a non-object profile with BAD_ARGS', async () => {
    const c = actionContent('career_pilot.emit_tailored_resume', { profile: 'nope' });
    await handleEmitTailoredResume(c, FAKE_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
  });

  it('responds ok with stored:false when the thread has no in-flight simulator run', async () => {
    // FAKE_SESSION.thread_id is null → no run accumulator to stash into; the
    // handler must answer honestly (ok, stored:false) rather than erroring the
    // agent turn. (The stored:true path needs a live run → box-verified.)
    const c = actionContent('career_pilot.emit_tailored_resume', {
      profile: {
        bio: ['A senior backend engineer well suited to this role.'],
        experience: [{ company: 'Acme', bullets: ['x'] }],
      },
    });
    await handleEmitTailoredResume(c, FAKE_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect(resp.frame.data.stored).toBe(false);
  });
});

// ── emit_cold_email (§24.146) ──────────────────────────────────────────────

describe('handleEmitColdEmail', () => {
  it('rejects a missing subject/body with BAD_ARGS', async () => {
    const c = actionContent('career_pilot.emit_cold_email', { subject: '', body: '' });
    await handleEmitColdEmail(c, FAKE_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
  });

  it('responds ok with stored:false when the thread has no in-flight simulator run', async () => {
    const c = actionContent('career_pilot.emit_cold_email', {
      subject: 'Your backend role',
      body: 'Hi there, I would love to share how my systems background fits this role. Could we find fifteen minutes? — Jane',
    });
    await handleEmitColdEmail(c, FAKE_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect(resp.frame.data.stored).toBe(false);
  });
});

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

// ── set_work_profile (§24.71 9.4b-2) ───────────────────────────────────────

describe('handleSetWorkProfile', () => {
  function readWorkPage(): { json: string | null; source: string | null; generated_at: string | null } {
    return getDb()
      .prepare(
        'SELECT work_profile_json AS json, work_profile_source AS source, work_profile_generated_at AS generated_at FROM candidate_profile WHERE id = 1',
      )
      .get() as { json: string | null; source: string | null; generated_at: string | null };
  }

  it('publishes a composed profile (object), stamping source=agent + generated_at', async () => {
    const profile = {
      name: 'Ada Lovelace',
      title: 'Staff Engineer',
      bio: ['Builds engines.'],
      experience: [{ role: 'Staff', company: 'AE', period: '2020 — Present', bullets: ['Shipped it.'] }],
      skills: ['Rust'],
      extraneous: 'dropped by projection',
    };
    const c = actionContent('career_pilot.set_work_profile', { profile });
    await handleSetWorkProfile(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect(resp.frame.data).toMatchObject({ name: 'Ada Lovelace' });

    const row = readWorkPage();
    expect(row.source).toBe('agent');
    expect(row.generated_at).toBeTruthy();
    const stored = JSON.parse(row.json!) as Record<string, unknown>;
    expect(stored.name).toBe('Ada Lovelace');
    expect(stored.skills).toEqual(['Rust']);
    expect(stored).not.toHaveProperty('extraneous'); // normalized through projectWorkProfile
  });

  it('accepts a JSON-string profile and round-trips it', async () => {
    const c = actionContent('career_pilot.set_work_profile', {
      profile: JSON.stringify({ name: 'Grace Hopper', title: 'RADM' }),
    });
    await handleSetWorkProfile(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);
    expect((JSON.parse(readWorkPage().json!) as { name: string }).name).toBe('Grace Hopper');
  });

  it('rejects a nameless / malformed profile with BAD_ARGS and does not write', async () => {
    const c = actionContent('career_pilot.set_work_profile', { profile: { title: 'no name' } });
    await handleSetWorkProfile(c, FAKE_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
    expect(readWorkPage()).toBeUndefined(); // no row created on rejection
  });
});

// ── set_preference (proactive guardrails, §24.52) ──────────────────────────

describe('handleSetPreference', () => {
  function readPref(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM preferences WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  it('persists a valid quiet_hours window to preferences', async () => {
    const c = actionContent('career_pilot.set_preference', { key: 'quiet_hours', value: '23:00-08:00' });
    await handleSetPreference(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect(resp.frame.data).toMatchObject({ key: 'quiet_hours', value: '23:00-08:00' });
    expect(readPref('quiet_hours')).toBe('23:00-08:00');
  });

  it('normalizes + persists a numeric cap', async () => {
    const c = actionContent('career_pilot.set_preference', {
      key: 'telegram_proactive_frequency_cap_per_day',
      value: 5,
    });
    await handleSetPreference(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    expect(readPref('telegram_proactive_frequency_cap_per_day')).toBe('5');
  });

  it('rejects an invalid quiet_hours value (BAD_ARGS), writes nothing', async () => {
    const c = actionContent('career_pilot.set_preference', { key: 'quiet_hours', value: 'whenever' });
    await handleSetPreference(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
    expect(readPref('quiet_hours')).toBeUndefined();
  });

  it('rejects a non-whitelisted key (BAD_ARGS)', async () => {
    const c = actionContent('career_pilot.set_preference', { key: 'live_mode', value: 'true' });
    await handleSetPreference(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
    expect(readPref('live_mode')).toBeUndefined();
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
  // Seed an obfuscated application + one pipeline event mentioning the real
  // company name. The mirror runs via handleRecordPipelineEvent's own hook, so
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
    await handleRecordPipelineEvent(
      actionContent('career_pilot.record_pipeline_event', {
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

  it('keeps audit count == pipeline_events count across an update then a new event', async () => {
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-r',
        patch: { company_name: 'Acme Corp', role_title: 'Backend', status: 'APPLIED' },
      }),
      FAKE_SESSION,
      inDb,
    );
    // Event 1 (obfuscated → redacted audit row).
    await handleRecordPipelineEvent(
      actionContent('career_pilot.record_pipeline_event', {
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
    await handleRecordPipelineEvent(
      actionContent('career_pilot.record_pipeline_event', {
        application_id: 'app-r',
        kind: 'recruiter_email',
        payload: { note: 'second from Acme Corp' },
      }),
      FAKE_SESSION,
      inDb,
    );

    const eventCount = (
      getDb().prepare("SELECT COUNT(*) AS n FROM pipeline_events WHERE application_id = 'app-r'").get() as {
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
      await handleRecordPipelineEvent(
        actionContent('career_pilot.record_pipeline_event', {
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

// ── record_pipeline_event ────────────────────────────────────────────────────

describe('handleRecordPipelineEvent', () => {
  beforeEach(async () => {
    // Seed an application so pipeline_events FK resolves.
    const c = actionContent('career_pilot.update_application', {
      id: 'app-pipeline',
      patch: { company_name: 'Acme', role_title: 'Backend', status: 'BOOKMARKED' },
    });
    await handleUpdateApplication(c, FAKE_SESSION, inDb);
  });

  it('INSERTs a pipeline event row + bumps last_activity_at', async () => {
    const before = (
      getDb().prepare('SELECT last_activity_at FROM applications WHERE id = ?').get('app-pipeline') as {
        last_activity_at: string;
      }
    ).last_activity_at;

    // Give it a tick so the timestamp comparison is observable.
    await new Promise((r) => setTimeout(r, 50));

    const c = actionContent('career_pilot.record_pipeline_event', {
      application_id: 'app-pipeline',
      kind: 'status_change',
      from_status: 'BOOKMARKED',
      to_status: 'APPLIED',
      payload: { summary: 'submitted application', source: 'candidate_message' },
    });
    await handleRecordPipelineEvent(c, FAKE_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      const data = resp.frame.data as { event_id: string };
      expect(data.event_id).toMatch(/^fe-/);
    }

    const event = getDb()
      .prepare('SELECT * FROM pipeline_events WHERE application_id = ?')
      .get('app-pipeline') as Record<string, unknown>;
    expect(event.kind).toBe('status_change');
    expect(event.from_status).toBe('BOOKMARKED');
    expect(event.to_status).toBe('APPLIED');
    expect(event.source).toBe('agent');

    const after = (
      getDb().prepare('SELECT last_activity_at FROM applications WHERE id = ?').get('app-pipeline') as {
        last_activity_at: string;
      }
    ).last_activity_at;
    expect(after).not.toBe(before); // bumped
  });

  it('returns NOT_FOUND when application_id does not exist', async () => {
    const c = actionContent('career_pilot.record_pipeline_event', {
      application_id: 'ghost-app',
      kind: 'status_change',
      payload: { summary: 'nope' },
    });
    await handleRecordPipelineEvent(c, FAKE_SESSION, inDb);

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
      .run('app-pipeline');

    const c = actionContent('career_pilot.record_pipeline_event', {
      application_id: 'app-pipeline',
      kind: 'recruiter_email',
      payload: {
        note: 'jane@acme.com from Acme Corp wrote about the $220k offer',
      },
    });
    await handleRecordPipelineEvent(c, FAKE_SESSION, inDb);

    // Action response is ok and references the new event_id.
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);

    // Private write preserves the truth.
    const privateRow = getDb()
      .prepare(`SELECT payload FROM pipeline_events WHERE application_id = 'app-pipeline' AND kind = 'recruiter_email'`)
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
    expect(publicRow!.category).toBe('pipeline');
    expect(publicRow!.summary).toContain('[REDACTED:fintech-a]');
    expect(publicRow!.summary).toContain('[EMAIL_REDACTED]');
    expect(publicRow!.summary).toContain('[AMOUNT_REDACTED]');
    expect(publicRow!.summary).not.toContain('Acme Corp');
    expect(publicRow!.summary).not.toContain('jane@acme.com');
    expect(publicRow!.summary).not.toContain('$220k');
  });
});

// ── proactive trace-capture (§24.24) ────────────────────────────────────────

describe('proactive trace-capture (§24.24)', () => {
  beforeEach(async () => {
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-pro',
        patch: { company_name: 'Acme', role_title: 'Backend', status: 'APPLIED' },
      }),
      FAKE_SESSION,
      inDb,
    );
  });

  it('record_pipeline_event → proactive=1 on a scheduled-task wake (pipeline_events + public mirror)', async () => {
    seedWake('task');
    const c = actionContent('career_pilot.record_pipeline_event', {
      application_id: 'app-pro',
      kind: 'status_change',
      to_status: 'SCREENING',
      payload: { summary: 'auto-advanced after recruiter email' },
    });
    await handleRecordPipelineEvent(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const fe = getDb().prepare(`SELECT proactive FROM pipeline_events WHERE application_id = 'app-pro'`).get() as {
      proactive: number;
    };
    expect(fe.proactive).toBe(1);
    const pub = getDb().prepare(`SELECT proactive FROM public_audit_trail WHERE category = 'pipeline'`).get() as {
      proactive: number;
    };
    expect(pub.proactive).toBe(1);
  });

  it('record_pipeline_event → proactive=0 on a direct chat wake', async () => {
    seedWake('chat');
    const c = actionContent('career_pilot.record_pipeline_event', {
      application_id: 'app-pro',
      kind: 'status_change',
      to_status: 'SCREENING',
      payload: { summary: 'logged after the candidate asked me to' },
    });
    await handleRecordPipelineEvent(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const fe = getDb().prepare(`SELECT proactive FROM pipeline_events WHERE application_id = 'app-pro'`).get() as {
      proactive: number;
    };
    expect(fe.proactive).toBe(0);
  });

  it('record_progress → proactive from the wake message kind (agent_name already real)', async () => {
    seedWake('webhook');
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: { subagent_name: 'research-company', stage: 'start', detail: 'digging into the company' },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const pub = getDb()
      .prepare(`SELECT agent_name, proactive FROM public_audit_trail WHERE category = 'subagent_progress'`)
      .get() as { agent_name: string; proactive: number };
    expect(pub.agent_name).toBe('research-company');
    expect(pub.proactive).toBe(1);
  });

  it('record_progress redacts $-amounts (e.g. a comp floor) but keeps bare counts', async () => {
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        subagent_name: 'scrape-jobs',
        stage: 'planning',
        detail: 'Query: senior backend. Comp floor $165k. 19 postings.',
      },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const pub = getDb()
      .prepare(
        `SELECT summary FROM public_audit_trail WHERE category = 'subagent_progress' AND agent_name = 'scrape-jobs'`,
      )
      .get() as { summary: string };
    expect(pub.summary).toContain('[AMOUNT_REDACTED]');
    expect(pub.summary).not.toContain('165');
    expect(pub.summary).toContain('19 postings'); // bare counts must survive
  });

  it('record_progress now redacts a tracked company name (centralized Pass 1+2, F2)', async () => {
    // This describe's beforeEach seeds app-pro with company "Acme" (an
    // obfuscated, non-public application; label misc-a). The OLD Pass-1-only
    // `sanitizeProgressDetail` fork left that name in the public /live feed; the
    // centralized pipeline routes progress through Pass 2, which now redacts it.
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        subagent_name: 'research-company',
        stage: 'digging',
        detail: 'researching Acme and its recent launches',
      },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const pub = getDb()
      .prepare(
        `SELECT summary FROM public_audit_trail WHERE category = 'subagent_progress' AND agent_name = 'research-company'`,
      )
      .get() as { summary: string };
    expect(pub.summary).toContain('[REDACTED:misc-a]');
    expect(pub.summary).not.toContain('Acme');
  });

  it('record_progress with application_id attributes the row via the HOST-derived ref (§24.61)', async () => {
    // beforeEach seeded app-pro (company Acme, non-public → label misc-a).
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        subagent_name: 'tailor-resume',
        stage: 'ranking-bullets',
        detail: 'weighing master-resume bullets against the JD',
        application_id: 'app-pro',
      },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const pub = getDb()
      .prepare(
        `SELECT application_ref, details_json FROM public_audit_trail
          WHERE category = 'subagent_progress' AND agent_name = 'tailor-resume'`,
      )
      .get() as { application_ref: string | null; details_json: string };
    // The container passed only the internal id; the public label is derived
    // host-side — the obfuscated label, never the company name.
    expect(pub.application_ref).toBe('misc-a');
    // details_json records the id (server-side only) so policy flips re-derive.
    expect(JSON.parse(pub.details_json).application_id).toBe('app-pro');
  });

  it('record_progress with application_id carries the REAL name for a public application (§24.61)', async () => {
    await handleUpdateApplication(
      actionContent('career_pilot.update_application', {
        id: 'app-rev',
        patch: { company_name: 'Wayne Enterprises', role_title: 'Staff', status: 'OFFER', public_state: 'public' },
      }),
      FAKE_SESSION,
      inDb,
    );
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        subagent_name: 'research-company',
        stage: 'digging',
        detail: 'mapping the engineering org',
        application_id: 'app-rev',
      },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const pub = getDb()
      .prepare(
        `SELECT application_ref FROM public_audit_trail
          WHERE category = 'subagent_progress' AND agent_name = 'research-company'`,
      )
      .get() as { application_ref: string | null };
    expect(pub.application_ref).toBe('Wayne Enterprises');
  });

  it('record_progress with an UNKNOWN application_id inserts ref-less — never an error (§24.61)', async () => {
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        subagent_name: 'draft-outreach',
        stage: 'drafting-body',
        detail: 'composing the outreach body',
        application_id: 'app-does-not-exist',
      },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const pub = getDb()
      .prepare(
        `SELECT application_ref, details_json FROM public_audit_trail
          WHERE category = 'subagent_progress' AND agent_name = 'draft-outreach'`,
      )
      .get() as { application_ref: string | null; details_json: string };
    expect(pub.application_ref).toBeNull();
    // The unresolvable id is not recorded either — the row is today's shape.
    expect(JSON.parse(pub.details_json).application_id).toBeUndefined();
  });

  // §24.154 — the rate-limit is a per-RUN burst cap (a recent window), NOT a
  // session-LIFETIME count. The lifetime count silently RATE_LIMITED every trace
  // once the long-lived §24.67 ops session accumulated past the cap (box: 10–11
  // rows in `sess-…kd5tyv`). These three pin the corrected scoping.
  function seedProgressRow(agent: string, summary: string, ageMin: number): void {
    const ts = new Date(Date.now() - ageMin * 60_000).toISOString();
    getDb()
      .prepare(
        `INSERT INTO public_audit_trail (id, seq, ts, category, agent_name, proactive, summary, details_json)
         VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail),
                 @ts, 'subagent_progress', @agent, 0, @summary, json_object('session_id', @sid))`,
      )
      .run({ id: `prog-${Math.random().toString(36).slice(2, 8)}`, ts, agent, summary, sid: FAKE_SESSION.id });
  }

  it('record_progress cap is a recent window — old session rows do NOT block a fresh run (§24.154)', async () => {
    // A long-lived ops session's historical rows (20 min old) must fall outside
    // the window — the exact regression: those rows used to pin the cap forever.
    for (let i = 0; i < PROGRESS_PER_SESSION_CAP + 4; i++) seedProgressRow('scrape-jobs', `old narration ${i}`, 20);
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: { subagent_name: 'scrape-jobs', stage: 'planning', detail: 'fresh narration after the old batch' },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);
    const fresh = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM public_audit_trail
          WHERE category = 'subagent_progress' AND agent_name = 'scrape-jobs' AND summary LIKE 'fresh narration%'`,
      )
      .get() as { n: number };
    expect(fresh.n).toBe(1);
  });

  it('record_progress still caps a burst WITHIN the window — the 7th call is rate-limited (§24.154)', async () => {
    for (let i = 0; i < PROGRESS_PER_SESSION_CAP; i++) seedProgressRow('pipeline-scribe', `recent narration ${i}`, 1);
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: { subagent_name: 'pipeline-scribe', stage: 'sweeping', detail: 'the over-cap call' },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    const frame = readResponse(c.requestId).frame as { ok: boolean; error?: { code?: string } };
    expect(frame.ok).toBe(false);
    expect(frame.error?.code).toBe('RATE_LIMITED');
  });

  it('dispatch-marker rows do NOT consume the record_progress cap (§24.154)', async () => {
    // Recent dispatch markers (written by handleRecordDispatch, not a real
    // record_progress call) must be excluded from the count.
    for (let i = 0; i < PROGRESS_PER_SESSION_CAP; i++) {
      seedProgressRow('research-company', 'Dispatched by the orchestrator.', 1);
    }
    const c = {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      payload: { subagent_name: 'research-company', stage: 'start', detail: 'a real progress note' },
    };
    await handleRecordProgress(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);
  });

  it('defaults to reactive (proactive=0) when no wake message is present', async () => {
    // No seedWake — only the beforeEach's trigger=0 response row exists.
    const c = actionContent('career_pilot.record_pipeline_event', {
      application_id: 'app-pro',
      kind: 'note',
      payload: { summary: 'no wake row in the inbound db' },
    });
    await handleRecordPipelineEvent(c, FAKE_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const fe = getDb().prepare(`SELECT proactive FROM pipeline_events WHERE application_id = 'app-pro'`).get() as {
      proactive: number;
    };
    expect(fe.proactive).toBe(0);
  });
});

// ── record_turn_telemetry (§24.34; §24.68 dual-write + sandbox branch) ──────

describe('handleRecordTurnTelemetry', () => {
  // Since §24.68 the handler classes traffic from the session's agent group,
  // so these tests seed the groups and speak as the owner unless exercising
  // the sandbox branch.
  beforeEach(() => {
    seedAgentGroups();
  });

  it('writes a category=turn row with the five telemetry columns + proactive from the wake', async () => {
    seedWake('task'); // proactive trigger
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-opus-4-8',
      tokens: 17000,
      cost_cents: 4,
      cache_hit: 1,
      latency_ms: 1234,
      record_calls: 2,
      details: {
        num_turns: 3,
        duration_api_ms: 1100,
        total_cost_usd: 0.041,
        // 900 cache_read / (100 input + 900 read + 200 creation) = 75%
        model_usage: { 'claude-opus-4-8': { input: 100, output: 50, cache_read: 900, cache_creation: 200 } },
      },
    });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const row = getDb()
      .prepare(
        `SELECT category, agent_name, proactive, model_used, tokens, cost_cents, cache_hit, cache_read_pct, latency_ms, summary, details_json
           FROM public_audit_trail WHERE category = 'turn'`,
      )
      .get() as {
      category: string;
      agent_name: string | null;
      proactive: number;
      model_used: string;
      tokens: number;
      cost_cents: number;
      cache_hit: number;
      cache_read_pct: number | null;
      latency_ms: number;
      summary: string;
      details_json: string;
    };
    expect(row.category).toBe('turn');
    expect(row.agent_name).toBeNull(); // a turn is not one subagent
    expect(row.proactive).toBe(1);
    expect(row.model_used).toBe('claude-opus-4-8');
    expect(row.tokens).toBe(17000);
    expect(row.cost_cents).toBe(4);
    expect(row.cache_hit).toBe(1);
    expect(row.cache_read_pct).toBe(75); // §24.55 quantitative cache lane
    expect(row.latency_ms).toBe(1234);
    expect(row.summary).toBe('turn complete');
    expect(JSON.parse(row.details_json).record_calls).toBe(2);
  });

  it('leaves cache_read_pct NULL when model_usage is absent or prompt-side empty (§24.55: unknown ≠ 0%)', async () => {
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-opus-4-8',
      tokens: 10,
      cost_cents: 1,
      cache_hit: 0,
      latency_ms: 10,
      record_calls: 0,
      details: { num_turns: 1, duration_api_ms: 10, total_cost_usd: 0.001, model_usage: {} },
    });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const row = getDb().prepare(`SELECT cache_read_pct FROM public_audit_trail WHERE category = 'turn'`).get() as {
      cache_read_pct: number | null;
    };
    expect(row.cache_read_pct).toBeNull();
  });

  it('does not write a row when telemetry_capture is disabled (kill switch)', async () => {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES ('telemetry_capture', 'false', datetime('now'))`,
      )
      .run();
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-opus-4-8',
      tokens: 100,
      cost_cents: 1,
      cache_hit: 0,
      latency_ms: 50,
      record_calls: 1,
    });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);

    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect((resp.frame.data as { skipped?: boolean }).skipped).toBe(true);
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM public_audit_trail WHERE category = 'turn'`).get() as { n: number }
    ).n;
    expect(n).toBe(0);
  });

  it('is defensive — missing/garbage fields land as NULL columns, cache_hit defaults 0', async () => {
    const c = actionContent('career_pilot.record_turn_telemetry', { record_calls: 1 });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const row = getDb()
      .prepare(
        `SELECT model_used, tokens, cost_cents, cache_hit, latency_ms FROM public_audit_trail WHERE category = 'turn'`,
      )
      .get() as {
      model_used: string | null;
      tokens: number | null;
      cost_cents: number | null;
      cache_hit: number;
      latency_ms: number | null;
    };
    expect(row.model_used).toBeNull();
    expect(row.tokens).toBeNull();
    expect(row.cost_cents).toBeNull();
    expect(row.cache_hit).toBe(0);
    expect(row.latency_ms).toBeNull();
  });

  // ── §24.68 dual-write + traffic classes ──────────────────────────────────

  interface RtRow {
    provider: string;
    surface: string;
    traffic_class: string;
    session_id: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    cost_microusd: number | null;
    ok: number;
    status_code: number | null;
  }

  function rtRows(): RtRow[] {
    return getDb().prepare('SELECT * FROM request_telemetry').all() as RtRow[];
  }

  it('dual-writes a request_telemetry row classed chat for an owner chat turn (cost cents → microUSD)', async () => {
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-opus-4-8',
      tokens: 17000,
      cost_cents: 4,
      cache_hit: 1,
      latency_ms: 1234,
      record_calls: 2,
      details: {
        num_turns: 3,
        model_usage: { 'claude-opus-4-8': { input: 100, output: 50, cache_read: 900, cache_creation: 200 } },
      },
    });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const rows = rtRows();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.provider).toBe('portkey');
    expect(r.surface).toBe('agent-turn');
    expect(r.traffic_class).toBe('chat');
    expect(r.session_id).toBe(OWNER_SESSION.id);
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.input_tokens).toBe(100); // summed from model_usage
    expect(r.output_tokens).toBe(50);
    expect(r.cache_read_tokens).toBe(900);
    expect(r.cache_creation_tokens).toBe(200);
    expect(r.cost_microusd).toBe(40_000); // 4 cents × 10,000
    expect(r.ok).toBe(1);
  });

  it('classes the owner ops session as ops', async () => {
    const opsSession: Session = { ...OWNER_SESSION, id: 'sess-ops', thread_id: 'internal:career-pilot-ops' };
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-opus-4-8',
      tokens: 100,
      cost_cents: 1,
      cache_hit: 0,
      latency_ms: 50,
      record_calls: 0,
    });
    await handleRecordTurnTelemetry(c, opsSession, inDb);
    expect(rtRows()[0].traffic_class).toBe('ops');
    // The ops turn still lands the public row — it's owner traffic.
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM public_audit_trail WHERE category = 'turn'`).get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('sandbox branch (§24.68 D-C): private telemetry row only, NEVER a public_audit_trail row', async () => {
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-haiku-4-5',
      tokens: 5000,
      cost_cents: 2,
      cache_hit: 0,
      latency_ms: 900,
      record_calls: 0,
      details: { num_turns: 2, model_usage: { 'claude-haiku-4-5': { input: 4000, output: 1000 } } },
    });
    await handleRecordTurnTelemetry(c, SANDBOX_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const rows = rtRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].traffic_class).toBe('sandbox');
    expect(rows[0].session_id).toBe(SANDBOX_SESSION.id);
    // The load-bearing invariant: no public row for a sandbox emission.
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM public_audit_trail WHERE category = 'turn'`).get() as { n: number }
    ).n;
    expect(n).toBe(0);
  });

  it('kill switch suppresses BOTH the public row and the request_telemetry row', async () => {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES ('telemetry_capture', 'false', datetime('now'))`,
      )
      .run();
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-opus-4-8',
      tokens: 100,
      cost_cents: 1,
      cache_hit: 0,
      latency_ms: 50,
      record_calls: 0,
    });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);
    expect(rtRows()).toHaveLength(0);
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM public_audit_trail WHERE category = 'turn'`).get() as { n: number }
    ).n;
    expect(n).toBe(0);
  });

  // ── §24.78 deterministic owner-path subagent-lifecycle traces ──────────────

  function progressRows(): Array<{ agent_name: string; summary: string; seq: number; details_json: string }> {
    return getDb()
      .prepare(
        `SELECT agent_name, summary, seq, details_json FROM public_audit_trail
          WHERE category = 'subagent_progress' ORDER BY seq ASC`,
      )
      .all() as Array<{ agent_name: string; summary: string; seq: number; details_json: string }>;
  }

  it('§24.134c: the turn row NO LONGER emits the dispatch lifecycle rows (they moved to record_dispatch)', async () => {
    const c = actionContent('career_pilot.record_turn_telemetry', {
      model_used: 'claude-haiku-4-5',
      tokens: 100,
      cost_cents: 1,
      cache_hit: 0,
      latency_ms: 50,
      record_calls: 0,
      subagent_dispatches: ['scrape-jobs'], // still carried as data, but no longer written as rows
    });
    await handleRecordTurnTelemetry(c, OWNER_SESSION, inDb);
    expect(progressRows()).toHaveLength(0);
    const turns = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM public_audit_trail WHERE category = 'turn'`).get() as { n: number }
    ).n;
    expect(turns).toBe(1); // the turn row itself still lands
  });
});

// ── §24.134c record_dispatch: the deterministic dispatch trace, now emitted at
// dispatch-OBSERVATION time (one call per subagent) so it precedes the
// subagent's own record_progress rows in seq order. ───────────────────────────
describe('handleRecordDispatch', () => {
  beforeEach(() => {
    seedAgentGroups();
  });

  function progressRows(): Array<{ agent_name: string; summary: string; seq: number; details_json: string }> {
    return getDb()
      .prepare(
        `SELECT agent_name, summary, seq, details_json FROM public_audit_trail
          WHERE category = 'subagent_progress' ORDER BY seq ASC`,
      )
      .all() as Array<{ agent_name: string; summary: string; seq: number; details_json: string }>;
  }

  it('writes one deterministic, PII-free subagent_progress row per call', async () => {
    const c = actionContent('career_pilot.record_dispatch', { subagent_name: 'scrape-jobs' });
    await handleRecordDispatch(c, OWNER_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const rows = progressRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBe('scrape-jobs');
    expect(rows[0].summary).toBe('Dispatched by the orchestrator.');
    expect(JSON.parse(rows[0].details_json).stage).toBe('dispatched');
  });

  it('emits in call order so two dispatches keep ascending seq (host writes MAX(seq)+1)', async () => {
    // The cross-subagent ordering vs the work itself is guaranteed by the
    // container emitting record_dispatch the instant the Task tool_use is seen,
    // BEFORE the subagent's record_progress — verified live on the box. Host-side
    // we just confirm sequential writes stay monotonic.
    await handleRecordDispatch(
      actionContent('career_pilot.record_dispatch', { subagent_name: 'scrape-jobs' }),
      OWNER_SESSION,
      inDb,
    );
    await handleRecordDispatch(
      actionContent('career_pilot.record_dispatch', { subagent_name: 'research-company' }),
      OWNER_SESSION,
      inDb,
    );
    const rows = progressRows();
    expect(rows.map((r) => r.agent_name)).toEqual(['scrape-jobs', 'research-company']);
    expect(rows[0].seq).toBeLessThan(rows[1].seq);
  });

  it('normalizes a renamed subagent name (pipeline-scribe → pipeline-scribe)', async () => {
    await handleRecordDispatch(
      actionContent('career_pilot.record_dispatch', { subagent_name: 'pipeline-scribe' }),
      OWNER_SESSION,
      inDb,
    );
    expect(progressRows().map((r) => r.agent_name)).toEqual(['pipeline-scribe']);
  });

  it('the flag off suppresses the row', async () => {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES ('owner_subagent_trace_emit_enabled', 'false', datetime('now'))`,
      )
      .run();
    const c = actionContent('career_pilot.record_dispatch', { subagent_name: 'scrape-jobs' });
    await handleRecordDispatch(c, OWNER_SESSION, inDb);
    expect(progressRows()).toHaveLength(0);
    expect(readResponse(c.requestId).frame.ok).toBe(true); // still acks
  });

  it('a sandbox emission never lands the lifecycle row (the perimeter invariant)', async () => {
    const c = actionContent('career_pilot.record_dispatch', { subagent_name: 'scrape-jobs' });
    await handleRecordDispatch(c, SANDBOX_SESSION, inDb);
    expect(progressRows()).toHaveLength(0);
  });
});

// ── record_request_telemetry (§24.68) ───────────────────────────────────────

describe('handleRecordRequestTelemetry', () => {
  beforeEach(() => {
    seedAgentGroups();
  });

  interface RtRow {
    provider: string;
    surface: string;
    traffic_class: string;
    session_id: string | null;
    model: string | null;
    input_tokens: number | null;
    cost_microusd: number | null;
    ok: number;
    status_code: number | null;
    error: string | null;
  }

  function rtRows(): RtRow[] {
    return getDb().prepare('SELECT * FROM request_telemetry').all() as RtRow[];
  }

  it('lands a container report with host-derived class, session and priced cost', async () => {
    const c = actionContent('career_pilot.record_request_telemetry', {
      provider: 'portkey',
      surface: 'rank-leads',
      ok: true,
      latency_ms: 800,
      status_code: 200,
      model: 'claude-haiku-4-5',
      input_tokens: 1500,
      output_tokens: 100,
    });
    await handleRecordRequestTelemetry(c, OWNER_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const r = rtRows()[0];
    expect(r.provider).toBe('portkey');
    expect(r.surface).toBe('rank-leads');
    expect(r.traffic_class).toBe('chat'); // derived host-side, not from payload
    expect(r.session_id).toBe(OWNER_SESSION.id);
    expect(r.input_tokens).toBe(1500);
    // 1500 × $1/MTok + 100 × $5/MTok on Haiku = 2000 µUSD — priced HERE, never by the container.
    expect(r.cost_microusd).toBe(2000);
  });

  it('lands a sandbox failure report classed sandbox (plain registration is safe by construction)', async () => {
    const c = actionContent('career_pilot.record_request_telemetry', {
      provider: 'serpapi',
      surface: 'serpapi-search',
      ok: false,
      latency_ms: 120,
      status_code: 429,
      error: '429 Too Many Requests',
    });
    await handleRecordRequestTelemetry(c, SANDBOX_SESSION, inDb);
    expect(readResponse(c.requestId).frame.ok).toBe(true);

    const r = rtRows()[0];
    expect(r.traffic_class).toBe('sandbox');
    expect(r.ok).toBe(0);
    expect(r.status_code).toBe(429);
    expect(r.error).toContain('429');
  });

  it('rejects non-slug provider/surface with BAD_ARGS and writes nothing', async () => {
    const c = actionContent('career_pilot.record_request_telemetry', {
      provider: 'Bad Provider!',
      surface: 'x',
      ok: true,
      latency_ms: 1,
    });
    await handleRecordRequestTelemetry(c, OWNER_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
    expect(rtRows()).toHaveLength(0);
  });

  it('acks {skipped} under the kill switch without writing', async () => {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES ('telemetry_capture', 'false', datetime('now'))`,
      )
      .run();
    const c = actionContent('career_pilot.record_request_telemetry', {
      provider: 'gmail',
      surface: 'pipeline-scribe-gmail',
      ok: true,
      latency_ms: 10,
    });
    await handleRecordRequestTelemetry(c, OWNER_SESSION, inDb);
    const resp = readResponse(c.requestId);
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect((resp.frame.data as { skipped?: boolean }).skipped).toBe(true);
    expect(rtRows()).toHaveLength(0);
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

  it('mints a company-keyed outreach token when the body carries the portal URL (§24.74)', async () => {
    process.env.GMAIL_STUB = '1';
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES ('portal_public_url', 'https://hire.example.com', datetime('now'))",
      )
      .run();
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'jane.doe@anthropic.com',
      subject: 'Reaching out',
      body: 'Hi Jane.\n\n---\n_Prepared by my agent. See it work live at https://hire.example.com._',
    });
    await handleCreateGmailDraft(c, OWNER_SESSION, inDb);

    expect(readResponse(c.requestId).frame.ok).toBe(true);
    const link = getDb()
      .prepare(
        "SELECT artifact_type, company, recipient, dest_path FROM attribution_link WHERE artifact_type = 'outreach'",
      )
      .get() as { artifact_type: string; company: string; recipient: string; dest_path: string } | undefined;
    expect(link).toBeTruthy();
    expect(link!.company).toBe('anthropic.com');
    expect(link!.recipient).toBe('jane.doe@anthropic.com');
    expect(link!.dest_path).toBe('/');
  });

  it('does NOT mint when the body has no portal URL', async () => {
    process.env.GMAIL_STUB = '1';
    getDb().prepare("DELETE FROM attribution_link WHERE artifact_type = 'outreach'").run();
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES ('portal_public_url', 'https://hire.example.com', datetime('now'))",
      )
      .run();
    const c = actionContent('career_pilot.create_gmail_draft', {
      to: 'jane.doe@anthropic.com',
      subject: 'Reaching out',
      body: 'Hi Jane, a plain body with no footer.',
    });
    await handleCreateGmailDraft(c, OWNER_SESSION, inDb);

    expect(readResponse(c.requestId).frame.ok).toBe(true);
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM attribution_link WHERE artifact_type = 'outreach'").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
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
