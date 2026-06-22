/**
 * Integration tests for the pipeline-scribe host-side action handlers
 * (Phase 3.2 §24.9 component 3).
 *
 * Five handlers covered:
 *   - handleGmailQueryDelta — fixture-mode read, sandbox guard,
 *                             NOT_IMPLEMENTED in non-fixture mode
 *   - handleCalendarQueryDelta — same
 *   - handlePersistPipelineState — transactional UPSERT email_events +
 *                                INSERT pipeline_scribe_output +
 *                                update sync-state pointers; validates
 *                                classification enum and excerpt cap
 *   - handleReadPipelineState — returns most-recent row JSON-parsed;
 *                             null when no rows exist
 *   - handleReadEmailEvents — filtered query by app/lead/thread/since;
 *                             respects max limit
 *
 * Mirrors the harness shape used by job-lead-actions.integration.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import {
  handleCalendarQueryDelta,
  handleFilterSeenEmailEvents,
  handleGetCalendarSyncState,
  handleGetGmailSyncState,
  handleGmailQueryDelta,
  handleLoadCalendarFixture,
  handleLoadGmailFixture,
  handlePersistPipelineState,
  handleReadEmailEvents,
  handleReadPipelineState,
} from './pipeline-actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-pipeline-test-${process.pid}`);
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
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
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

// ── handleGmailQueryDelta (deprecated stub — see §24.9 amendment) ─────────

describe('handleGmailQueryDelta (deprecated stub)', () => {
  it('returns NOT_IMPLEMENTED (real-mode moved container-side)', async () => {
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('refuses with FORBIDDEN for sandbox sessions before stub message', async () => {
    const c = actionContent('career_pilot.gmail_query_delta', {});
    await handleGmailQueryDelta(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

describe('handleCalendarQueryDelta (deprecated stub)', () => {
  it('returns NOT_IMPLEMENTED (real-mode moved container-side)', async () => {
    const c = actionContent('career_pilot.calendar_query_delta', {});
    await handleCalendarQueryDelta(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.calendar_query_delta', {});
    await handleCalendarQueryDelta(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

// ── handleLoadGmailFixture / handleLoadCalendarFixture ────────────────────

describe('handleLoadGmailFixture', () => {
  it('returns parsed messages for a single-message JSON fixture', async () => {
    const c = actionContent('career_pilot.load_gmail_fixture', { name: 'acme-applied-confirmation' });
    await handleLoadGmailFixture(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { messages: Array<{ id: string }>; fixture: string };
    expect(data.fixture).toBe('acme-applied-confirmation');
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].id).toBe('msg-acme-confirm-001');
  });

  it('returns a multi-message JSONL fixture as an ordered list', async () => {
    const c = actionContent('career_pilot.load_gmail_fixture', { name: 'acme-pipeline-multi' });
    await handleLoadGmailFixture(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { messages: Array<{ id: string }> };
    expect(data.messages).toHaveLength(4);
  });

  it('returns BAD_ARGS when name is missing', async () => {
    const c = actionContent('career_pilot.load_gmail_fixture', {});
    await handleLoadGmailFixture(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('BAD_ARGS');
  });

  it('returns FIXTURE_NOT_FOUND when the name does not exist', async () => {
    const c = actionContent('career_pilot.load_gmail_fixture', { name: 'no-such-fixture' });
    await handleLoadGmailFixture(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FIXTURE_NOT_FOUND');
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.load_gmail_fixture', { name: 'acme-applied-confirmation' });
    await handleLoadGmailFixture(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

describe('handleGetGmailSyncState', () => {
  it('returns history_id=null on first run (no state)', async () => {
    const c = actionContent('career_pilot.get_gmail_sync_state', {});
    await handleGetGmailSyncState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { history_id: string | null };
    expect(data.history_id).toBeNull();
  });

  it('returns the stored history_id after persist writes it', async () => {
    await handlePersistPipelineState(
      actionContent('career_pilot.persist_pipeline_state', makeValidPayload({ gmail_history_id: 'h-12345' })),
      OWNER_SESSION,
      inDb,
    );
    const c = actionContent('career_pilot.get_gmail_sync_state', {});
    await handleGetGmailSyncState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { history_id: string };
    expect(data.history_id).toBe('h-12345');
  });

  it('never stores the stringified-null historyId (the 2026-06-13 box bug)', async () => {
    // The agent passing the *string* "null" must NOT be written — storing it
    // sends startHistoryId=null to Gmail → 400 and a permanently broken delta.
    await handlePersistPipelineState(
      actionContent('career_pilot.persist_pipeline_state', makeValidPayload({ gmail_history_id: 'null' })),
      OWNER_SESSION,
      inDb,
    );
    const row = getDb().prepare("SELECT history_id FROM gmail_sync_state WHERE account_id = 'primary'").get();
    expect(row).toBeUndefined(); // nothing written
  });

  it('heals an already-stored "null" by sanitizing on read', async () => {
    // Simulate the box's broken state: a literal "null" already in the table.
    getDb()
      .prepare("INSERT INTO gmail_sync_state (account_id, history_id, last_full_sync_at) VALUES ('primary', 'null', ?)")
      .run('2026-06-13T00:00:00Z');
    const c = actionContent('career_pilot.get_gmail_sync_state', {});
    await handleGetGmailSyncState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    // get_gmail_sync_state returns null → the container falls to full-sync + reseeds.
    expect((res.frame.data as { history_id: string | null }).history_id).toBeNull();
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.get_gmail_sync_state', {});
    await handleGetGmailSyncState(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

describe('handleGetCalendarSyncState', () => {
  it('returns empty sync_tokens on first run', async () => {
    const c = actionContent('career_pilot.get_calendar_sync_state', {});
    await handleGetCalendarSyncState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { sync_tokens: Record<string, string> };
    expect(data.sync_tokens).toEqual({});
  });

  it('returns the stored sync_tokens after persist writes them', async () => {
    await handlePersistPipelineState(
      actionContent(
        'career_pilot.persist_pipeline_state',
        makeValidPayload({ calendar_sync_tokens: { primary: 't-abc', work: 't-xyz' } }),
      ),
      OWNER_SESSION,
      inDb,
    );
    const c = actionContent('career_pilot.get_calendar_sync_state', {});
    await handleGetCalendarSyncState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { sync_tokens: Record<string, string> };
    expect(data.sync_tokens).toEqual({ primary: 't-abc', work: 't-xyz' });
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.get_calendar_sync_state', {});
    await handleGetCalendarSyncState(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

describe('handleLoadCalendarFixture', () => {
  it('returns parsed events for a calendar fixture', async () => {
    const c = actionContent('career_pilot.load_calendar_fixture', { name: 'acme-onsite-tomorrow' });
    await handleLoadCalendarFixture(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    const data = res.frame.data as { events: Array<{ id: string; meet_link: string | null }>; fixture: string };
    expect(data.fixture).toBe('acme-onsite-tomorrow');
    expect(data.events).toHaveLength(1);
    expect(data.events[0].id).toBe('evt-acme-onsite');
    expect(data.events[0].meet_link).toContain('meet.google.example');
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.load_calendar_fixture', { name: 'acme-onsite-tomorrow' });
    await handleLoadCalendarFixture(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});

// ── handlePersistPipelineState ──────────────────────────────────────────────

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

describe('handlePersistPipelineState', () => {
  it('writes email_events, pipeline_scribe_output, and updates sync-state in one transaction', async () => {
    const c = actionContent('career_pilot.persist_pipeline_state', makeValidPayload());
    await handlePersistPipelineState(c, OWNER_SESSION, inDb);

    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');

    const eventRows = getDb()
      .prepare('SELECT gmail_msg_id, classification, evidence_excerpt FROM email_events')
      .all() as Array<{ gmail_msg_id: string; classification: string; evidence_excerpt: string }>;
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].classification).toBe('application_confirmation');

    const outputRows = getDb()
      .prepare('SELECT id, gmail_history_id, cheap_out, cost_usd FROM pipeline_scribe_output')
      .all() as Array<{ id: string; gmail_history_id: string; cheap_out: number; cost_usd: number }>;
    expect(outputRows).toHaveLength(1);
    expect(outputRows[0].gmail_history_id).toBe('hist-12345');
    expect(outputRows[0].cheap_out).toBe(0);

    const syncRow = getDb().prepare("SELECT history_id FROM gmail_sync_state WHERE account_id = 'primary'").get() as {
      history_id: string;
    };
    expect(syncRow.history_id).toBe('hist-12345');

    const calRow = getDb()
      .prepare("SELECT sync_token FROM calendar_sync_state WHERE calendar_id = 'primary'")
      .get() as { sync_token: string };
    expect(calRow.sync_token).toBe('cal-token-abc');
  });

  it('UPSERTs email_events on conflict by gmail_msg_id (re-classification on second run)', async () => {
    const c1 = actionContent('career_pilot.persist_pipeline_state', makeValidPayload());
    await handlePersistPipelineState(c1, OWNER_SESSION, inDb);

    const c2 = actionContent(
      'career_pilot.persist_pipeline_state',
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
    await handlePersistPipelineState(c2, OWNER_SESSION, inDb);

    const eventRows = getDb().prepare('SELECT classification FROM email_events').all() as Array<{
      classification: string;
    }>;
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].classification).toBe('noise');
  });

  it('truncates evidence_excerpt to <=500 chars', async () => {
    const longText = 'x'.repeat(900);
    const c = actionContent(
      'career_pilot.persist_pipeline_state',
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
    await handlePersistPipelineState(c, OWNER_SESSION, inDb);

    const row = getDb().prepare("SELECT evidence_excerpt FROM email_events WHERE gmail_msg_id = 'msg-long'").get() as {
      evidence_excerpt: string;
    };
    expect(row.evidence_excerpt.length).toBeLessThanOrEqual(500);
  });

  it('rejects invalid classification with BAD_ARGS (or PERSIST_ERROR) and writes nothing', async () => {
    const c = actionContent(
      'career_pilot.persist_pipeline_state',
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
    await handlePersistPipelineState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);

    const eventRows = getDb().prepare('SELECT gmail_msg_id FROM email_events').all() as Array<{ gmail_msg_id: string }>;
    const outputRows = getDb().prepare('SELECT id FROM pipeline_scribe_output').all();
    expect(eventRows).toHaveLength(0);
    expect(outputRows).toHaveLength(0);
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.persist_pipeline_state', makeValidPayload());
    await handlePersistPipelineState(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });

  it('allows cheap_out=true with empty events array', async () => {
    const c = actionContent(
      'career_pilot.persist_pipeline_state',
      makeValidPayload({ new_email_events: [], narratives: [], attention: [], cheap_out: true }),
    );
    await handlePersistPipelineState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);

    const outputRow = getDb().prepare('SELECT cheap_out FROM pipeline_scribe_output').get() as { cheap_out: number };
    expect(outputRow.cheap_out).toBe(1);
  });
});

// ── handleReadPipelineState ─────────────────────────────────────────────────

describe('handleReadPipelineState', () => {
  it('returns state=null when no curator runs have happened yet', async () => {
    const c = actionContent('career_pilot.read_pipeline_state', {});
    await handleReadPipelineState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toEqual({ state: null });
  });

  it('returns the most-recent run with JSON-parsed narratives/attention/suggestions', async () => {
    const p1 = actionContent('career_pilot.persist_pipeline_state', makeValidPayload());
    await handlePersistPipelineState(p1, OWNER_SESSION, inDb);

    await new Promise((r) => setTimeout(r, 10));

    const p2 = actionContent(
      'career_pilot.persist_pipeline_state',
      makeValidPayload({
        new_email_events: [],
        narratives: [{ company: 'Stripe', current_state: 'screen', timeline_excerpt: [] }],
      }),
    );
    await handlePersistPipelineState(p2, OWNER_SESSION, inDb);

    const c = actionContent('career_pilot.read_pipeline_state', {});
    await handleReadPipelineState(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    const state = (res.frame.data as { state: { narratives: Array<{ company: string }> } }).state;
    expect(state.narratives).toHaveLength(1);
    expect(state.narratives[0].company).toBe('Stripe');
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.read_pipeline_state', {});
    await handleReadPipelineState(c, SANDBOX_SESSION, inDb);
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
  insertLead.run({
    id: 'lead-acme',
    sjid: 'sj-acme',
    url: 'https://acme.example/jobs/1',
    fp: 'fp-acme',
    title: 'Senior Engineer',
    company: 'Acme',
    now,
  });
  insertLead.run({
    id: 'lead-stripe',
    sjid: 'sj-stripe',
    url: 'https://stripe.example/jobs/1',
    fp: 'fp-stripe',
    title: 'Backend Engineer',
    company: 'Stripe',
    now,
  });
}

describe('handleReadEmailEvents', () => {
  beforeEach(async () => {
    seedLinkedApplicationsAndLeads();
    const p = actionContent(
      'career_pilot.persist_pipeline_state',
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
    await handlePersistPipelineState(p, OWNER_SESSION, inDb);
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

// ── handleFilterSeenEmailEvents (§24.102) ─────────────────────────────────

describe('handleFilterSeenEmailEvents', () => {
  async function seedClassified(gmailMsgId: string): Promise<void> {
    await handlePersistPipelineState(
      actionContent(
        'career_pilot.persist_pipeline_state',
        makeValidPayload({
          new_email_events: [
            { gmail_msg_id: gmailMsgId, thread_id: `thread-${gmailMsgId}`, classification: 'noise', confidence: 0.3 },
          ],
        }),
      ),
      OWNER_SESSION,
      inDb,
    );
  }

  it('returns only the gmail_msg_ids already present in email_events', async () => {
    await seedClassified('msg-seen-1');
    await seedClassified('msg-seen-2');
    const c = actionContent('career_pilot.filter_seen_email_events', {
      gmail_msg_ids: ['msg-seen-1', 'msg-seen-2', 'msg-fresh-1'],
    });
    await handleFilterSeenEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect((res.frame.data.seen as string[]).sort()).toEqual(['msg-seen-1', 'msg-seen-2']);
    expect(res.frame.data.enabled).toBe(true);
  });

  it('returns seen: [] for empty input (no query)', async () => {
    const c = actionContent('career_pilot.filter_seen_email_events', { gmail_msg_ids: [] });
    await handleFilterSeenEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.seen).toEqual([]);
  });

  it('returns seen: [] when the skip toggle is disabled (full re-classification pass)', async () => {
    await seedClassified('msg-seen-x');
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES ('pipeline_scribe_skip_classified_messages', 'false', datetime('now'))",
      )
      .run();
    const c = actionContent('career_pilot.filter_seen_email_events', { gmail_msg_ids: ['msg-seen-x'] });
    await handleFilterSeenEmailEvents(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.seen).toEqual([]);
    expect(res.frame.data.enabled).toBe(false);
  });

  it('refuses with FORBIDDEN for sandbox sessions', async () => {
    const c = actionContent('career_pilot.filter_seen_email_events', { gmail_msg_ids: ['msg-x'] });
    await handleFilterSeenEmailEvents(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});
