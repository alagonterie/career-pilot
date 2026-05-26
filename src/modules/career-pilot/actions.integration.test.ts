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
import {
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

function actionContent(action: string, payload: Record<string, unknown>): {
  action: string;
  requestId: string;
  payload: Record<string, unknown>;
} {
  return { action, requestId: `req-${Math.random().toString(36).slice(2, 10)}`, payload };
}

function readResponse(requestId: string): ResponseFrame {
  const row = inDb
    .prepare("SELECT content FROM messages_in WHERE id = ?")
    .get(`cp-resp-${requestId}`) as { content: string } | undefined;
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

    const row1 = getDb()
      .prepare('SELECT full_name, target_roles FROM candidate_profile WHERE id = 1')
      .get() as { full_name: string; target_roles: string | null };
    expect(row1.full_name).toBe('Jane Doe');
    expect(row1.target_roles).toBeNull();

    const c2 = actionContent('career_pilot.update_profile_field', {
      field: 'target_roles',
      value: '["Staff Backend"]',
    });
    await handleUpdateProfileField(c2, FAKE_SESSION, inDb);

    const row2 = getDb()
      .prepare('SELECT full_name, target_roles FROM candidate_profile WHERE id = 1')
      .get() as { full_name: string; target_roles: string };
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

    const event = getDb()
      .prepare('SELECT * FROM funnel_events WHERE application_id = ?')
      .get('app-funnel') as Record<string, unknown>;
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
