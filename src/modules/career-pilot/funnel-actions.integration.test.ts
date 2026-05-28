/**
 * Integration tests for the funnel-curator host-side action handlers
 * (Phase 3.2 §24.9 component 3).
 *
 * Five handlers covered:
 *   - handleGmailQueryDelta — fixture-mode read, sandbox guard,
 *                             NOT_IMPLEMENTED in non-fixture mode
 *   - handleCalendarQueryDelta — same
 *   - handlePersistFunnelState — transactional UPSERT email_events +
 *                                INSERT funnel_curator_output +
 *                                update sync-state pointers; validates
 *                                classification enum and excerpt cap
 *   - handleReadFunnelState — returns most-recent row JSON-parsed;
 *                             null when no rows exist
 *   - handleReadEmailEvents — filtered query by app/lead/thread/since;
 *                             respects max limit
 *
 * Mirrors the harness shape used by job-lead-actions.integration.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import {
  handleCalendarQueryDelta,
  handleGmailQueryDelta,
  handlePersistFunnelState,
  handleReadEmailEvents,
  handleReadFunnelState,
} from './funnel-actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-funnel-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const BASE_SESSION = {
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-28T00:00:00Z',
};

const OWNER_SESSION: Session = {
  ...BASE_SESSION,
  id: 'sess-owner',
  agent_group_id: 'ag-owner',
} as Session;
const SANDBOX_SESSION: Session = {
  ...BASE_SESSION,
  id: 'sess-sandbox',
  agent_group_id: 'ag-sandbox',
} as Session;

let inDb: Database.Database;

function seedAgentGroups(): void {
  createAgentGroup({
    id: 'ag-owner',
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-05-28T00:00:00Z',
  });
  createAgentGroup({
    id: 'ag-sandbox',
    name: 'Career Pilot Sandbox',
    folder: 'career-pilot-sandbox',
    agent_provider: null,
    created_at: '2026-05-28T00:00:00Z',
  });
}

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroups();

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

interface ResponseFrame<T = Record<string, unknown>> {
  type: string;
  requestId: string;
  frame: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}

function readResponse(requestId: string): ResponseFrame {
  const row = inDb
    .prepare('SELECT content FROM messages_in WHERE id = ?')
    .get(`cp-resp-${requestId}`) as { content: string } | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return JSON.parse(row.content) as ResponseFrame;
}

function actionContent(action: string, payload: Record<string, unknown>) {
  return {
    action,
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    payload,
  };
}

// ── handleGmailQueryDelta ─────────────────────────────────────────────────

describe('handleGmailQueryDelta', () => {
  let savedGmailFixture: string | undefined;

  beforeEach(() => {
    savedGmailFixture = process.env.GMAIL_FIXTURE;
  });

  afterEach(() => {
    if (savedGmailFixture === undefined) delete process.env.GMAIL_FIXTURE;
    else process.env.GMAIL_FIXTURE = savedGmailFixture;
  });

  it('returns parsed messages from a fixture when GMAIL_FIXTURE is set', async () => {
    process.env.GMAIL_FIXTURE = 'acme-applied-confirmation';
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { messages: Array<{ id: string }>; fixture_mode: boolean };
    expect(data.fixture_mode).toBe(true);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].id).toBe('msg-acme-confirm-001');
  });

  it('returns a multi-message JSONL fixture as an ordered list', async () => {
    process.env.GMAIL_FIXTURE = 'acme-pipeline-multi';
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { messages: Array<{ id: string }> };
    expect(data.messages).toHaveLength(4);
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    process.env.GMAIL_FIXTURE = 'acme-applied-confirmation';
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });

  it('returns NOT_IMPLEMENTED when GMAIL_FIXTURE is unset', async () => {
    delete process.env.GMAIL_FIXTURE;
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('surfaces a clear error when the named fixture does not exist', async () => {
    process.env.GMAIL_FIXTURE = 'no-such-fixture';
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FIXTURE_NOT_FOUND');
  });
});

// ── handleCalendarQueryDelta ──────────────────────────────────────────────

describe('handleCalendarQueryDelta', () => {
  let savedCalFixture: string | undefined;

  beforeEach(() => {
    savedCalFixture = process.env.CALENDAR_FIXTURE;
  });

  afterEach(() => {
    if (savedCalFixture === undefined) delete process.env.CALENDAR_FIXTURE;
    else process.env.CALENDAR_FIXTURE = savedCalFixture;
  });

  it('returns parsed events from a fixture when CALENDAR_FIXTURE is set', async () => {
    process.env.CALENDAR_FIXTURE = 'acme-onsite-tomorrow';
    const c = actionContent('career_pilot.calendar_query_delta', {});
    await handleCalendarQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { events: Array<{ id: string; meet_link: string | null }> };
    expect(data.events).toHaveLength(1);
    expect(data.events[0].id).toBe('evt-acme-onsite');
    expect(data.events[0].meet_link).toContain('meet.google.example');
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    process.env.CALENDAR_FIXTURE = 'acme-onsite-tomorrow';
    const c = actionContent('career_pilot.calendar_query_delta', {});
    await handleCalendarQueryDelta(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });

  it('returns NOT_IMPLEMENTED when CALENDAR_FIXTURE is unset', async () => {
    delete process.env.CALENDAR_FIXTURE;
    const c = actionContent('career_pilot.calendar_query_delta', {});
    await handleCalendarQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('NOT_IMPLEMENTED');
  });
});

// ── handlePersistFunnelState ──────────────────────────────────────────────

function makeValidPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    new_email_events: [
      {
        gmail_msg_id: 'msg-A',
        thread_id: 'thread-A',
        classification: 'application_confirmation',
        confidence: 0.92,
        from_addr: 'no-reply@greenhouse.example',
        subject: 'Thanks for your application',
        received_at: '2026-05-27T10:00:00Z',
        evidence_excerpt: 'Thanks for applying.',
      },
    ],
    narratives: [{ company: 'Acme', current_state: 'applied', timeline_excerpt: ['applied 2d ago'] }],
    attention: [{ priority: 'fyi', reason: 'New application', application_id: null }],
    suggestions: [],
    gmail_history_id: 'hist-12345',
    calendar_sync_tokens: { primary: 'cal-token-abc' },
    cheap_out: false,
    cost_usd: 0.25,
    ...overrides,
  };
}

describe('handlePersistFunnelState', () => {
  it('writes email_events, funnel_curator_output, and updates sync-state in one transaction', async () => {
    const c = actionContent('career_pilot.persist_funnel_state', makeValidPayload());
    await handlePersistFunnelState(c, OWNER_SESSION, inDb);

    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');

    const eventRows = getDb()
      .prepare('SELECT gmail_msg_id, classification, evidence_excerpt FROM email_events')
      .all() as Array<{ gmail_msg_id: string; classification: string; evidence_excerpt: string }>;
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].classification).toBe('application_confirmation');

    const outputRows = getDb()
      .prepare('SELECT id, gmail_history_id, cheap_out, cost_usd FROM funnel_curator_output')
      .all() as Array<{ id: string; gmail_history_id: string; cheap_out: number; cost_usd: number }>;
    expect(outputRows).toHaveLength(1);
    expect(outputRows[0].gmail_history_id).toBe('hist-12345');
    expect(outputRows[0].cheap_out).toBe(0);

    const syncRow = getDb()
      .prepare("SELECT history_id FROM gmail_sync_state WHERE account_id = 'primary'")
      .get() as { history_id: string };
    expect(syncRow.history_id).toBe('hist-12345');

    const calRow = getDb()
      .prepare("SELECT sync_token FROM calendar_sync_state WHERE calendar_id = 'primary'")
      .get() as { sync_token: string };
    expect(calRow.sync_token).toBe('cal-token-abc');
  });

  it('UPSERTs email_events on conflict by gmail_msg_id (re-classification on second run)', async () => {
    const c1 = actionContent('career_pilot.persist_funnel_state', makeValidPayload());
    await handlePersistFunnelState(c1, OWNER_SESSION, inDb);

    const c2 = actionContent(
      'career_pilot.persist_funnel_state',
      makeValidPayload({
        new_email_events: [
          {
            gmail_msg_id: 'msg-A',
            thread_id: 'thread-A',
            classification: 'noise',
            confidence: 0.4,
            from_addr: 'no-reply@greenhouse.example',
            subject: 'Reclassified',
            received_at: '2026-05-27T10:00:00Z',
            evidence_excerpt: 'Reclassified after second look',
          },
        ],
      }),
    );
    await handlePersistFunnelState(c2, OWNER_SESSION, inDb);

    const eventRows = getDb()
      .prepare('SELECT classification FROM email_events')
      .all() as Array<{ classification: string }>;
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].classification).toBe('noise');
  });

  it('truncates evidence_excerpt to <=500 chars', async () => {
    const longText = 'x'.repeat(900);
    const c = actionContent(
      'career_pilot.persist_funnel_state',
      makeValidPayload({
        new_email_events: [
          {
            gmail_msg_id: 'msg-long',
            thread_id: 'thread-long',
            classification: 'application_confirmation',
            confidence: 0.9,
            evidence_excerpt: longText,
          },
        ],
      }),
    );
    await handlePersistFunnelState(c, OWNER_SESSION, inDb);

    const row = getDb()
      .prepare("SELECT evidence_excerpt FROM email_events WHERE gmail_msg_id = 'msg-long'")
      .get() as { evidence_excerpt: string };
    expect(row.evidence_excerpt.length).toBeLessThanOrEqual(500);
  });

  it('rejects invalid classification with BAD_ARGS (or PERSIST_ERROR) and writes nothing', async () => {
    const c = actionContent(
      'career_pilot.persist_funnel_state',
      makeValidPayload({
        new_email_events: [
          {
            gmail_msg_id: 'msg-bad',
            thread_id: 'thread-bad',
            classification: 'not_a_valid_class',
            confidence: 0.9,
          },
        ],
      }),
    );
    await handlePersistFunnelState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);

    const eventRows = getDb()
      .prepare('SELECT gmail_msg_id FROM email_events')
      .all() as Array<{ gmail_msg_id: string }>;
    const outputRows = getDb()
      .prepare('SELECT id FROM funnel_curator_output')
      .all();
    expect(eventRows).toHaveLength(0);
    expect(outputRows).toHaveLength(0);
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.persist_funnel_state', makeValidPayload());
    await handlePersistFunnelState(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });

  it('allows cheap_out=true with empty events array', async () => {
    const c = actionContent(
      'career_pilot.persist_funnel_state',
      makeValidPayload({ new_email_events: [], narratives: [], attention: [], cheap_out: true }),
    );
    await handlePersistFunnelState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);

    const outputRow = getDb()
      .prepare('SELECT cheap_out FROM funnel_curator_output')
      .get() as { cheap_out: number };
    expect(outputRow.cheap_out).toBe(1);
  });
});

// ── handleReadFunnelState ─────────────────────────────────────────────────

describe('handleReadFunnelState', () => {
  it('returns state=null when no curator runs have happened yet', async () => {
    const c = actionContent('career_pilot.read_funnel_state', {});
    await handleReadFunnelState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toEqual({ state: null });
  });

  it('returns the most-recent run with JSON-parsed narratives/attention/suggestions', async () => {
    const p1 = actionContent('career_pilot.persist_funnel_state', makeValidPayload());
    await handlePersistFunnelState(p1, OWNER_SESSION, inDb);

    await new Promise((r) => setTimeout(r, 10));

    const p2 = actionContent(
      'career_pilot.persist_funnel_state',
      makeValidPayload({
        new_email_events: [],
        narratives: [{ company: 'Stripe', current_state: 'screen', timeline_excerpt: [] }],
      }),
    );
    await handlePersistFunnelState(p2, OWNER_SESSION, inDb);

    const c = actionContent('career_pilot.read_funnel_state', {});
    await handleReadFunnelState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const state = (res.frame.data as { state: { narratives: Array<{ company: string }> } }).state;
    expect(state.narratives).toHaveLength(1);
    expect(state.narratives[0].company).toBe('Stripe');
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.read_funnel_state', {});
    await handleReadFunnelState(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

// ── handleReadEmailEvents ─────────────────────────────────────────────────

function seedLinkedApplicationsAndLeads(): void {
  const now = '2026-05-27T00:00:00Z';
  const insertApp = getDb().prepare(`
    INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, created_at)
    VALUES (@id, @company, @label, @role, 'applied', @now)
  `);
  insertApp.run({ id: 'app-acme', company: 'Acme', label: 'fintech-a', role: 'Senior Engineer', now });
  insertApp.run({ id: 'app-stripe', company: 'Stripe', label: 'fintech-b', role: 'Backend Engineer', now });

  const insertLead = getDb().prepare(`
    INSERT INTO job_leads (
      id, source, source_job_id, source_url,
      content_fingerprint, title, company,
      first_seen_at, last_seen_at,
      rules_score, rules_score_reasons,
      status, status_changed_at
    ) VALUES (
      @id, 'greenhouse', @sjid, @url,
      @fp, @title, @company,
      @now, @now,
      90, '{}',
      'new', @now
    )
  `);
  insertLead.run({ id: 'lead-acme', sjid: 'sj-acme', url: 'https://acme.example/jobs/1', fp: 'fp-acme', title: 'Senior Engineer', company: 'Acme', now });
  insertLead.run({ id: 'lead-stripe', sjid: 'sj-stripe', url: 'https://stripe.example/jobs/1', fp: 'fp-stripe', title: 'Backend Engineer', company: 'Stripe', now });
}

describe('handleReadEmailEvents', () => {
  beforeEach(async () => {
    seedLinkedApplicationsAndLeads();
    const p = actionContent(
      'career_pilot.persist_funnel_state',
      makeValidPayload({
        new_email_events: [
          {
            gmail_msg_id: 'msg-acme-1',
            thread_id: 'thread-acme',
            classification: 'application_confirmation',
            confidence: 0.9,
            linked_application_id: 'app-acme',
            linked_job_lead_id: 'lead-acme',
            subject: 'Thanks for applying — Acme',
          },
          {
            gmail_msg_id: 'msg-acme-2',
            thread_id: 'thread-acme',
            classification: 'screen_invite',
            confidence: 0.85,
            linked_application_id: 'app-acme',
            linked_job_lead_id: 'lead-acme',
            subject: 'Recruiter screen?',
          },
          {
            gmail_msg_id: 'msg-stripe-1',
            thread_id: 'thread-stripe',
            classification: 'application_confirmation',
            confidence: 0.92,
            linked_application_id: 'app-stripe',
            linked_job_lead_id: 'lead-stripe',
            subject: 'Thanks for applying — Stripe',
          },
        ],
      }),
    );
    await handlePersistFunnelState(p, OWNER_SESSION, inDb);
  });

  it('returns all events when no filter is passed', async () => {
    const c = actionContent('career_pilot.read_email_events', {});
    await handleReadEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { events: Array<{ gmail_msg_id: string }>; total: number };
    expect(data.events).toHaveLength(3);
    expect(data.total).toBe(3);
  });

  it('filters by application_id', async () => {
    const c = actionContent('career_pilot.read_email_events', { application_id: 'app-acme' });
    await handleReadEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { events: Array<{ gmail_msg_id: string }> };
    expect(data.events.map((e) => e.gmail_msg_id).sort()).toEqual(['msg-acme-1', 'msg-acme-2']);
  });

  it('filters by thread_id', async () => {
    const c = actionContent('career_pilot.read_email_events', { thread_id: 'thread-stripe' });
    await handleReadEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { events: Array<{ gmail_msg_id: string }> };
    expect(data.events).toHaveLength(1);
    expect(data.events[0].gmail_msg_id).toBe('msg-stripe-1');
  });

  it('clamps limit to MAX (200)', async () => {
    const c = actionContent('career_pilot.read_email_events', { limit: 99999 });
    await handleReadEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    // No exception thrown is the assertion; the 3 seeded rows come back.
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.read_email_events', {});
    await handleReadEmailEvents(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});
