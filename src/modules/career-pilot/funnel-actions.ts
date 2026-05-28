/**
 * Funnel-curator delivery action handlers (host side, Phase 3.2 §24.9).
 *
 * Five handlers wired into the delivery sweep for the funnel-curator
 * subagent's tool palette and the orchestrator's on-demand consumer path:
 *   - career_pilot.gmail_query_delta      — Gmail incremental fetch
 *                                           (historyId-driven; 404 → window
 *                                           full-sync). GMAIL_FIXTURE env
 *                                           routes to a fixture file.
 *   - career_pilot.calendar_query_delta   — Calendar incremental fetch
 *                                           (per-calendar syncToken; 410 →
 *                                           full re-sync). CALENDAR_FIXTURE
 *                                           env routes to a fixture file.
 *   - career_pilot.persist_funnel_state   — single transactional write:
 *                                           UPSERT new email_events rows +
 *                                           INSERT funnel_curator_output +
 *                                           update sync-state pointers.
 *   - career_pilot.read_funnel_state      — most-recent funnel_curator_output
 *                                           row (JSON-parsed). Consumer reads.
 *   - career_pilot.read_email_events      — filtered query against
 *                                           email_events for narrative pulls.
 *
 * All five reject non-owner agent-group sessions via the same folder check
 * `create_gmail_draft` uses (the sandbox group must not touch the
 * candidate's real inbox under any circumstances).
 *
 * Real Gmail/Calendar API integration is post-DoD wiring (the OneCLI
 * Gmail OAuth scope `gmail.readonly` is already granted by the
 * `add-gmail-tool` skill; the calendar scope by `add-gcal-tool`). For
 * tests + e2e, the *_FIXTURE env vars route through the fixture loader.
 */
import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import { loadCalendarFixture, loadGmailFixture } from './funnel-fixture-loader.js';
import {
  EMAIL_CLASSIFICATIONS,
  type EmailClassification,
  type FunnelCuratorOutput,
  type NewEmailEvent,
} from './funnel-types.js';

// ── Response writer (mirrors job-lead-actions.ts) ─────────────────────────

type ActionFrame =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

function writeResponse(inDb: Database.Database, requestId: string, frame: ActionFrame): void {
  insertMessage(inDb, {
    id: `cp-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'career_pilot_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

function reqId(content: Record<string, unknown>): string {
  return (content.requestId as string) || 'unknown';
}

function payload(content: Record<string, unknown>): Record<string, unknown> {
  return (content.payload as Record<string, unknown>) ?? {};
}

// ── Sandbox guard ─────────────────────────────────────────────────────────

function rejectIfSandbox(inDb: Database.Database, requestId: string, session: Session, action: string): boolean {
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: `${action} is not available in this agent group (sandbox sessions cannot read or write funnel data).`,
      },
    });
    return true;
  }
  return false;
}

const EVIDENCE_EXCERPT_MAX = 500;

const CLASSIFICATION_SET: Set<string> = new Set(EMAIL_CLASSIFICATIONS);

function generateRunId(): string {
  return `fcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── 1. handleGmailQueryDelta (deprecated stub — see §24.9 amendment) ───────

// The original §24.9 drill-in framed this as a host-roundtrip wrapper around
// Google Gmail REST. That framing is superseded; the real-API call happens
// container-side via the OneCLI HTTPS_PROXY (the §24.6 rank_leads pattern).
// Fixture-mode now flows through `handleLoadGmailFixture` instead. This
// handler is kept as NOT_IMPLEMENTED for symmetry with `create_gmail_draft`'s
// reserved real-mode path.
export async function handleGmailQueryDelta(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'gmail_query_delta')) return;
  writeResponse(inDb, requestId, {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message:
        'gmail_query_delta is now container-side (§24.9 amendment). This host action is a reserved stub.',
    },
  });
}

// ── 2. handleCalendarQueryDelta (deprecated stub — see §24.9 amendment) ────

export async function handleCalendarQueryDelta(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'calendar_query_delta')) return;
  writeResponse(inDb, requestId, {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message:
        'calendar_query_delta is now container-side (§24.9 amendment). This host action is a reserved stub.',
    },
  });
}

// ── 2a. handleLoadGmailFixture (host-side fixture loader) ──────────────────
//
// Called by the container-side `query_gmail_delta` MCP tool when its
// `GMAIL_FIXTURE` env var is set. Loads from `tests/fixtures/gmail/<name>.json`
// via the existing loader and returns parsed messages. Real-API mode does
// not roundtrip through here.

export async function handleLoadGmailFixture(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'load_gmail_fixture')) return;
  const p = payload(content);
  const name = p.name as string | undefined;
  if (!name || typeof name !== 'string') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'name is required (fixture file basename, no extension)' },
    });
    return;
  }
  try {
    const messages = loadGmailFixture(name);
    log.info('load_gmail_fixture', { fixture: name, count: messages.length });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { messages, fixture: name } as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.error('load_gmail_fixture failed', { fixture: name, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'FIXTURE_NOT_FOUND', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── 2b. handleLoadCalendarFixture ──────────────────────────────────────────

export async function handleLoadCalendarFixture(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'load_calendar_fixture')) return;
  const p = payload(content);
  const name = p.name as string | undefined;
  if (!name || typeof name !== 'string') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'name is required (fixture file basename, no extension)' },
    });
    return;
  }
  try {
    const events = loadCalendarFixture(name);
    log.info('load_calendar_fixture', { fixture: name, count: events.length });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { events, fixture: name } as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.error('load_calendar_fixture failed', { fixture: name, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'FIXTURE_NOT_FOUND', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── 3. handlePersistFunnelState ───────────────────────────────────────────

function truncateExcerpt(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (text.length <= EVIDENCE_EXCERPT_MAX) return text;
  return text.slice(0, EVIDENCE_EXCERPT_MAX - 1) + '…';
}

function validateClassification(value: unknown): EmailClassification {
  if (typeof value !== 'string' || !CLASSIFICATION_SET.has(value)) {
    throw new Error(`invalid classification: ${String(value)}`);
  }
  return value as EmailClassification;
}

export async function handlePersistFunnelState(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'persist_funnel_state')) return;

  const p = payload(content) as Partial<FunnelCuratorOutput>;

  if (!Array.isArray(p.new_email_events)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'new_email_events must be an array (empty allowed)' },
    });
    return;
  }
  if (!Array.isArray(p.narratives)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'narratives must be an array' },
    });
    return;
  }
  if (!Array.isArray(p.attention)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'attention must be an array' },
    });
    return;
  }
  if (!Array.isArray(p.suggestions)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'suggestions must be an array' },
    });
    return;
  }

  try {
    const db = getDb();
    const runId = generateRunId();
    const nowIso = new Date().toISOString();

    // Validate event classifications up front so a bad event aborts before
    // any writes.
    const events: NewEmailEvent[] = p.new_email_events.map((e, idx) => {
      if (typeof e !== 'object' || e === null) {
        throw new Error(`new_email_events[${idx}] is not an object`);
      }
      if (typeof e.gmail_msg_id !== 'string' || typeof e.thread_id !== 'string') {
        throw new Error(`new_email_events[${idx}] missing gmail_msg_id or thread_id`);
      }
      validateClassification(e.classification);
      return {
        gmail_msg_id: e.gmail_msg_id,
        thread_id: e.thread_id,
        classification: e.classification,
        confidence: typeof e.confidence === 'number' ? e.confidence : 0,
        linked_job_lead_id: e.linked_job_lead_id ?? null,
        linked_application_id: e.linked_application_id ?? null,
        from_addr: e.from_addr ?? null,
        subject: e.subject ?? null,
        received_at: e.received_at ?? null,
        evidence_excerpt: truncateExcerpt(e.evidence_excerpt),
      };
    });

    db.transaction(() => {
      const upsertEvent = db.prepare(`
        INSERT INTO email_events (
          gmail_msg_id, thread_id, classification, confidence,
          linked_job_lead_id, linked_application_id,
          from_addr, subject, received_at, evidence_excerpt,
          classified_at, classified_by_run_id
        ) VALUES (
          @gmail_msg_id, @thread_id, @classification, @confidence,
          @linked_job_lead_id, @linked_application_id,
          @from_addr, @subject, @received_at, @evidence_excerpt,
          @classified_at, @classified_by_run_id
        )
        ON CONFLICT(gmail_msg_id) DO UPDATE SET
          thread_id             = excluded.thread_id,
          classification        = excluded.classification,
          confidence            = excluded.confidence,
          linked_job_lead_id    = excluded.linked_job_lead_id,
          linked_application_id = excluded.linked_application_id,
          from_addr             = excluded.from_addr,
          subject               = excluded.subject,
          received_at           = excluded.received_at,
          evidence_excerpt      = excluded.evidence_excerpt,
          classified_at         = excluded.classified_at,
          classified_by_run_id  = excluded.classified_by_run_id
      `);
      for (const e of events) {
        upsertEvent.run({
          ...e,
          classified_at: nowIso,
          classified_by_run_id: runId,
        });
      }

      db.prepare(`
        INSERT INTO funnel_curator_output (
          id, run_at, gmail_history_id, calendar_sync_tokens,
          narratives_json, attention_json, suggestions_json,
          cheap_out, cost_usd
        ) VALUES (
          @id, @run_at, @gmail_history_id, @calendar_sync_tokens,
          @narratives_json, @attention_json, @suggestions_json,
          @cheap_out, @cost_usd
        )
      `).run({
        id: runId,
        run_at: nowIso,
        gmail_history_id: p.gmail_history_id ?? null,
        calendar_sync_tokens: JSON.stringify(p.calendar_sync_tokens ?? {}),
        narratives_json: JSON.stringify(p.narratives),
        attention_json: JSON.stringify(p.attention),
        suggestions_json: JSON.stringify(p.suggestions),
        cheap_out: p.cheap_out ? 1 : 0,
        cost_usd: p.cost_usd ?? null,
      });

      if (p.gmail_history_id) {
        db.prepare(`
          INSERT INTO gmail_sync_state (account_id, history_id, last_full_sync_at)
          VALUES ('primary', @history_id, @now)
          ON CONFLICT(account_id) DO UPDATE SET
            history_id = excluded.history_id,
            last_full_sync_at = excluded.last_full_sync_at
        `).run({ history_id: p.gmail_history_id, now: nowIso });
      }

      if (p.calendar_sync_tokens) {
        const upsertCal = db.prepare(`
          INSERT INTO calendar_sync_state (account_id, calendar_id, sync_token, last_full_sync_at)
          VALUES ('primary', @calendar_id, @sync_token, @now)
          ON CONFLICT(account_id, calendar_id) DO UPDATE SET
            sync_token = excluded.sync_token,
            last_full_sync_at = excluded.last_full_sync_at
        `);
        for (const [calendar_id, sync_token] of Object.entries(p.calendar_sync_tokens)) {
          upsertCal.run({ calendar_id, sync_token, now: nowIso });
        }
      }
    })();

    log.info('funnel_curator_output persisted', {
      runId,
      events: events.length,
      narratives: p.narratives.length,
      attention: p.attention.length,
      suggestions: p.suggestions.length,
      cheap_out: !!p.cheap_out,
    });

    writeResponse(inDb, requestId, {
      ok: true,
      data: { run_id: runId, events_written: events.length },
    });
  } catch (err) {
    log.error('handlePersistFunnelState failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'PERSIST_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── 4. handleReadFunnelState ──────────────────────────────────────────────

interface FunnelCuratorOutputRow {
  id: string;
  run_at: string;
  gmail_history_id: string | null;
  calendar_sync_tokens: string;
  narratives_json: string;
  attention_json: string;
  suggestions_json: string;
  cheap_out: number;
  cost_usd: number | null;
}

export async function handleReadFunnelState(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'read_funnel_state')) return;

  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, run_at, gmail_history_id, calendar_sync_tokens,
                narratives_json, attention_json, suggestions_json,
                cheap_out, cost_usd
         FROM funnel_curator_output
         ORDER BY run_at DESC
         LIMIT 1`,
      )
      .get() as FunnelCuratorOutputRow | undefined;

    if (!row) {
      writeResponse(inDb, requestId, { ok: true, data: { state: null } });
      return;
    }

    writeResponse(inDb, requestId, {
      ok: true,
      data: {
        state: {
          id: row.id,
          run_at: row.run_at,
          gmail_history_id: row.gmail_history_id,
          calendar_sync_tokens: JSON.parse(row.calendar_sync_tokens),
          narratives: JSON.parse(row.narratives_json),
          attention: JSON.parse(row.attention_json),
          suggestions: JSON.parse(row.suggestions_json),
          cheap_out: row.cheap_out === 1,
          cost_usd: row.cost_usd,
        },
      },
    });
  } catch (err) {
    log.error('handleReadFunnelState failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── 5. handleReadEmailEvents ──────────────────────────────────────────────

interface EmailEventRow {
  gmail_msg_id: string;
  thread_id: string;
  classification: string;
  confidence: number;
  linked_job_lead_id: string | null;
  linked_application_id: string | null;
  from_addr: string | null;
  subject: string | null;
  received_at: string | null;
  evidence_excerpt: string | null;
  classified_at: string;
  classified_by_run_id: string;
}

const READ_EMAIL_EVENTS_DEFAULT_LIMIT = 50;
const READ_EMAIL_EVENTS_MAX_LIMIT = 200;

export async function handleReadEmailEvents(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'read_email_events')) return;

  const p = payload(content);
  const applicationId = (p.application_id as string | undefined) ?? null;
  const leadId = (p.lead_id as string | undefined) ?? null;
  const threadId = (p.thread_id as string | undefined) ?? null;
  const since = (p.since as string | undefined) ?? null;
  const rawLimit = typeof p.limit === 'number' ? p.limit : READ_EMAIL_EVENTS_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), READ_EMAIL_EVENTS_MAX_LIMIT);

  try {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (applicationId) {
      where.push('linked_application_id = @application_id');
      params.application_id = applicationId;
    }
    if (leadId) {
      where.push('linked_job_lead_id = @lead_id');
      params.lead_id = leadId;
    }
    if (threadId) {
      where.push('thread_id = @thread_id');
      params.thread_id = threadId;
    }
    if (since) {
      where.push('classified_at >= @since');
      params.since = since;
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT gmail_msg_id, thread_id, classification, confidence,
                linked_job_lead_id, linked_application_id,
                from_addr, subject, received_at, evidence_excerpt,
                classified_at, classified_by_run_id
         FROM email_events
         ${whereClause}
         ORDER BY classified_at DESC
         LIMIT @limit`,
      )
      .all(params) as EmailEventRow[];

    writeResponse(inDb, requestId, {
      ok: true,
      data: { events: rows, total: rows.length },
    });
  } catch (err) {
    log.error('handleReadEmailEvents failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}
