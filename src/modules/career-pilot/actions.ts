/**
 * Career-pilot delivery action handlers (host side).
 *
 * The container's MCP tools cannot write to `data/v2.db` (the host's
 * long-lived WAL connection precludes cross-mount writes). The contract,
 * per STRATEGY.md §6.1:
 *
 *   1. Container writes `kind: 'system'` to outbound.db with
 *      `{ action: 'career_pilot.<verb>', requestId, payload }`.
 *   2. Host's delivery sweep dispatches via this module's registered
 *      handlers (see `index.ts` for the `registerDeliveryAction` calls).
 *   3. Handler applies the DB op against the central `data/v2.db`
 *      (`getDb()`), writes a response back to the session's inbound.db.
 *   4. Container's `sendAction` helper polls inbound.db for the response.
 *
 * Response shape (parsed by `container/agent-runner/src/career-pilot/action.ts`):
 *   { type: 'career_pilot_response', requestId, frame: { ok: true, data } | { ok: false, error: { code, message } } }
 *
 * All handlers MUST write a response — leaving the container blocked on a
 * timeout when the host actually saw the request is the worst-of-both-
 * worlds failure mode.
 */
import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import { mirrorFunnelEvent, publicApplicationRef, resanitizeApplicationAuditTrail } from '../portal/public-audit.js';
import { sanitize, sanitizeForPublic } from '../portal/sanitizer.js';
import { pass3Active } from '../portal/sanitizer-pass3.js';
import { isKnownApplicationStatus, upsertPublicFunnelView } from '../portal/public-funnel-view.js';
import { upsertPublicKitView } from '../portal/public-kit-view.js';
import type { Session } from '../../types.js';

import { reactToStatusTransitions } from './interview-kit-trigger.js';
import { validateProactivePref } from './quiet-hours.js';

// ── Response writer (shared by all handlers) ──

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
    trigger: 0, // response should not wake the agent
  });
}

function reqId(content: Record<string, unknown>): string {
  return (content.requestId as string) || 'unknown';
}

function payload(content: Record<string, unknown>): Record<string, unknown> {
  return (content.payload as Record<string, unknown>) ?? {};
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Warn (do not reject) when an application status is outside the canonical
 * vocabulary (APPLICATION_STATUSES). Prod is pre-LIVE_MODE with no real rows;
 * a hard reject risks breaking an in-flight agent turn on an unforeseen
 * status. The funnel read-model's deriveFunnelStage handles unknowns gracefully.
 */
function warnUnknownStatus(status: unknown, where: string): void {
  if (typeof status === 'string' && status && !isKnownApplicationStatus(status)) {
    log.warn(`${where}: non-canonical application status`, { status });
  }
}

/**
 * Owner-only gate for private career_pilot actions — the host-side half of the
 * sandbox's two-layer isolation (STRATEGY.md §24.19). Layer 1 is the sandbox
 * container's `disallowedTools` list, which removes these tools from the SDK
 * context; this is Layer 2: even if that list is ever misconfigured, a
 * non-owner session (any agent group whose folder !== 'career-pilot' — i.e.
 * career-pilot-sandbox) can never read or write candidate data. Writes a
 * FORBIDDEN response and returns true when the caller is not the owner group;
 * returns false (caller proceeds) otherwise. Applied at the single
 * registration chokepoint in index.ts so every action is guarded by
 * construction.
 */
export function denyIfNotOwner(
  action: string,
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): boolean {
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') {
    writeResponse(inDb, reqId(content), {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: `${action} is not available in this agent group (sandbox sessions cannot access private career-pilot data).`,
      },
    });
    return true;
  }
  return false;
}

// ── update_profile_field ───────────────────────────────────────────────────

const PROFILE_FIELDS = new Set([
  'full_name',
  'display_name',
  'bio',
  'target_roles',
  'location_pref',
  'comp_floor',
  'master_resume',
  'skills',
  'github_url',
  'linkedin_url',
  'x_url',
  'website_url',
  'why_this_exists',
  'headshot_path',
  'brand_color_hsl',
  'gmail_account',
]);

// `candidate_profile` typed columns. The agent passes free-form values to
// `update_profile_field`; these get normalized to each column's canonical
// storage form so a reader (the dev inspector, render-persona, the curator)
// always finds the shape it expects. Without this, the agent storing
// target_roles as a comma string or an over-escaped JSON string left the field
// unparseable → it read as empty (the onboarding-stuck-at-5/6 bug).
const ARRAY_PROFILE_FIELDS = new Set(['target_roles', 'skills']);
const NUMBER_PROFILE_FIELDS = new Set(['comp_floor']);
const OBJECT_PROFILE_FIELDS = new Set(['location_pref']);

/** Parse a string to a string[] — tolerating a double-encoded JSON string. */
function tryParseStringArray(s: string): string[] | null {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    if (typeof parsed === 'string') return tryParseStringArray(parsed);
  } catch {
    // not JSON — fall through to the caller's next strategy
  }
  return null;
}

/** Coerce any agent-supplied value into a clean string[] (for target_roles/skills). */
function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const s = value.trim();
  if (!s) return [];
  // A clean JSON array, or an over-escaped one (`[\"x\"]` → un-escape, then parse).
  const parsed = tryParseStringArray(s) ?? tryParseStringArray(s.replace(/\\"/g, '"'));
  if (parsed) return parsed.map((v) => v.trim()).filter(Boolean);
  // A human list: drop wrapping brackets, split on comma/newline, strip quotes.
  return s
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(/[,\n]/)
    .map((x) => x.replace(/^[\s"'\\]+|[\s"'\\]+$/g, ''))
    .filter(Boolean);
}

/**
 * Normalize an `update_profile_field` value to its column's storage form before
 * binding: array fields → JSON-array text, comp_floor → a number, location_pref
 * → JSON-object text, everything else → a string (or null). Defensive against
 * however the agent serialized the value.
 */
export function normalizeProfileValue(field: string, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (ARRAY_PROFILE_FIELDS.has(field)) return JSON.stringify(coerceStringArray(value));
  if (NUMBER_PROFILE_FIELDS.has(field)) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const cleaned = String(value).replace(/[^0-9.-]/g, '');
    // Number('') === 0 (not NaN), so an all-non-numeric input must short-circuit.
    const n = cleaned === '' ? NaN : Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (OBJECT_PROFILE_FIELDS.has(field)) {
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object') return JSON.stringify(parsed);
      } catch {
        // not JSON — store the raw string
      }
      return value;
    }
    return JSON.stringify(value);
  }
  // Plain string columns — coerce non-strings so the bind can't crash.
  return typeof value === 'string' ? value : String(value);
}

export async function handleUpdateProfileField(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const field = p.field as string;
  const value = p.value;

  if (!field || !PROFILE_FIELDS.has(field)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_FIELD', message: `unknown field "${field}"` },
    });
    return;
  }

  const now = new Date().toISOString();
  try {
    const db = getDb();
    // INSERT OR REPLACE the single-row table: we always want a row with id=1
    // even if the previous turn was the very first update.
    db.prepare(
      `INSERT INTO candidate_profile (id, updated_at) VALUES (1, @updated_at)
       ON CONFLICT(id) DO NOTHING`,
    ).run({ updated_at: now });

    db.prepare(`UPDATE candidate_profile SET ${field} = @value, updated_at = @updated_at WHERE id = 1`).run({
      value: normalizeProfileValue(field, value),
      updated_at: now,
    });

    log.info('candidate_profile updated', { field });
    writeResponse(inDb, requestId, { ok: true, data: { field } });
  } catch (err) {
    log.error('handleUpdateProfileField failed', { field, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── set_preference (proactive guardrails, §24.52) ──────────────────────────
//
// The candidate's natural-language path to adjust quiet hours / the proactive
// cap ("don't ping me before 9", "mute alerts on weekends", "up to 5 a day").
// The agent translates the request into a whitelisted key + value; the host
// validates + normalizes (validateProactivePref) and writes the `preferences`
// row — the same single source of truth a settings UI would write. Owner-only
// (registered behind denyIfNotOwner). Reversible, non-destructive.

export async function handleSetPreference(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);

  const result = validateProactivePref(p.key as string, p.value);
  if (!result.ok) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: result.message } });
    return;
  }

  try {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(result.key, result.value, new Date().toISOString());
    log.info('career_pilot.set_preference', { key: result.key });
    writeResponse(inDb, requestId, { ok: true, data: { key: result.key, value: result.value } });
  } catch (err) {
    log.error('handleSetPreference failed', { key: result.key, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── proactive classification (STRATEGY.md §24.24) ───────────────────────────
//
// Was the turn that triggered this write proactive (the agent woke itself:
// a scheduled `task`, a `webhook`, or an agent `system` message) or reactive
// (a direct `chat`/`chat-sdk` message)? Mirrors the §24.18 pause-gate
// convention in `countDueReactiveMessages`: reactive == kind IN
// ('chat','chat-sdk'). Read from the most-recent wake (`trigger = 1`) row in
// the session's inbound DB. Defaults to reactive (false) when no wake row is
// present — conservative; the ◆ marker never over-claims autonomy.
const REACTIVE_KINDS = new Set(['chat', 'chat-sdk']);

export function deriveProactive(inDb: Database.Database): boolean {
  try {
    const row = inDb.prepare('SELECT kind FROM messages_in WHERE trigger = 1 ORDER BY seq DESC LIMIT 1').get() as
      | { kind: string }
      | undefined;
    if (!row) return false;
    return !REACTIVE_KINDS.has(row.kind);
  } catch {
    return false;
  }
}

// ── record_progress ────────────────────────────────────────────────────────

const PROGRESS_DETAIL_CAP = 200;
const PROGRESS_PER_SESSION_CAP = 6;

/**
 * INSERT one `subagent_progress` row into the public mirror. `seq = MAX+1` under
 * the host's single synchronous writer (§24.14). When the call attributed
 * itself to an application (§24.61), `applicationRef` is the HOST-derived
 * public label and `applicationId` rides details_json (server-side only —
 * /api/activity never delivers details_json) so policy flips can re-derive.
 */
function insertProgressRow(
  db: Database.Database,
  args: {
    id: string;
    ts: string;
    agentName: string;
    proactive: number;
    summary: string;
    stage: string;
    sessionId: string;
    applicationRef: string | null;
    applicationId: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO public_audit_trail (id, seq, ts, category, agent_name, proactive, application_ref, summary, details_json)
     VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail),
             @ts, 'subagent_progress', @agentName, @proactive, @applicationRef, @summary, @detailsJson)`,
  ).run({
    id: args.id,
    ts: args.ts,
    agentName: args.agentName,
    proactive: args.proactive,
    applicationRef: args.applicationRef,
    summary: args.summary,
    detailsJson: JSON.stringify({
      stage: args.stage,
      session_id: args.sessionId,
      ...(args.applicationId ? { application_id: args.applicationId } : {}),
    }),
  });
}

/**
 * `record_progress` writes a subagent's progress trace to the public `/live`
 * feed. The detail string is obfuscated through the SINGLE sanitizer pipeline
 * (§24.12, F2) — Pass 1 (PII regex) + Pass 2 (company/alias) + Pass 3 (host-side
 * semantic obfuscation, when active). The old Pass-1-only `sanitizeProgressDetail`
 * fork is gone: `research-company` / `build-interview-kit` progress strings name
 * the target company, its products, and events — all of which now get redacted.
 *
 * Pass 3 inactive (CI / local-dev, no Portkey key) → synchronous Pass 1+2 insert
 * (today's behavior, plus the company redaction Pass 2 now adds). Pass 3 active
 * (the box / prod) → ack first, then sanitize + insert-or-withhold OFF the hot
 * path so the semantic LLM call never blocks the agent; a Pass-3 failure
 * withholds the row (fail-safe).
 */
export async function handleRecordProgress(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const subagent_name = p.subagent_name as string;
  const stage = p.stage as string;
  const detail = p.detail as string;
  // §24.61 optional application attribution: the container passes only the
  // internal id; the public ref is derived host-side below.
  const application_id = typeof p.application_id === 'string' && p.application_id ? p.application_id : null;

  if (!subagent_name || !stage || typeof detail !== 'string' || !detail) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'BAD_ARGS',
        message: 'subagent_name, stage, and detail are required (detail must be a non-empty string)',
      },
    });
    return;
  }

  const detailCapped = detail.length > PROGRESS_DETAIL_CAP ? `${detail.slice(0, PROGRESS_DETAIL_CAP - 3)}...` : detail;

  try {
    const db = getDb();

    // Per-(session, subagent) soft rate-limit. Approximates "per-run" — a
    // single Task call doesn't have a stable run_id exposed to MCP handlers,
    // and sessions are short-lived (~5 min ceiling), so per-session counting
    // is a workable proxy. Spec calls for 7th-call rejection (cap=6 prior).
    const sessionLike = `%"session_id":"${session.id}"%`;
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM public_audit_trail
            WHERE category = 'subagent_progress'
              AND agent_name = @agent
              AND details_json LIKE @sessionLike`,
        )
        .get({ agent: subagent_name, sessionLike }) as { n: number }
    ).n;
    if (count >= PROGRESS_PER_SESSION_CAP) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `record_progress cap reached (${count} prior calls for ${subagent_name} in this session)`,
        },
      });
      return;
    }

    const id = generateId('prog');
    const now = new Date().toISOString();
    const proactive = deriveProactive(inDb) ? 1 : 0;
    // §24.61: derive the public-safe ref from the internal id. An unknown or
    // label-less application yields null → the row inserts ref-less (today's
    // shape), never an error — attribution is best-effort by design.
    const applicationRef = application_id ? publicApplicationRef(db, application_id) : null;
    const applicationId = applicationRef ? application_id : null;

    if (pass3Active(db)) {
      // Ack first, then sanitize + insert-or-withhold off the hot path so the
      // semantic LLM call never blocks the agent's MCP response.
      writeResponse(inDb, requestId, { ok: true, data: { id, stage } });
      void (async () => {
        try {
          const { text, ok } = await sanitizeForPublic(detailCapped, { db });
          if (!ok) {
            log.warn('record_progress: Pass 3 unavailable — withholding /live row', { subagent_name });
            return;
          }
          insertProgressRow(db, {
            id,
            ts: now,
            agentName: subagent_name,
            proactive,
            summary: text,
            stage,
            sessionId: session.id,
            applicationRef,
            applicationId,
          });
        } catch (asyncErr) {
          log.error('record_progress async mirror failed', { subagent_name, asyncErr });
        }
      })();
      return;
    }

    // Pass 3 inactive: deterministic Pass 1+2, fully synchronous (today's path).
    const summary = sanitize(detailCapped, { db });
    insertProgressRow(db, {
      id,
      ts: now,
      agentName: subagent_name,
      proactive,
      summary,
      stage,
      sessionId: session.id,
      applicationRef,
      applicationId,
    });
    writeResponse(inDb, requestId, { ok: true, data: { id, stage } });
  } catch (err) {
    log.error('handleRecordProgress failed', { subagent_name, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── record_turn_telemetry ───────────────────────────────────────────────────

const TURN_TELEMETRY_SUMMARY = 'turn complete';

/** Coerce a payload value to a finite number, or null (for nullable columns). */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Derive the quantitative cache lane (§24.55): the share of the turn's
 * prompt-side tokens served from cache, 0–100, from the per-model usage the
 * container forwards in `details.model_usage`. NULL when there is no usage
 * map or the prompt-side sum is zero (unknown ≠ 0%).
 */
function deriveCacheReadPct(details: Record<string, unknown>): number | null {
  const usage = details.model_usage;
  if (!usage || typeof usage !== 'object') return null;
  let cacheRead = 0;
  let promptTotal = 0;
  for (const u of Object.values(usage as Record<string, unknown>)) {
    if (!u || typeof u !== 'object') continue;
    const m = u as { input?: unknown; cache_read?: unknown; cache_creation?: unknown };
    const read = typeof m.cache_read === 'number' && Number.isFinite(m.cache_read) ? m.cache_read : 0;
    const input = typeof m.input === 'number' && Number.isFinite(m.input) ? m.input : 0;
    const creation = typeof m.cache_creation === 'number' && Number.isFinite(m.cache_creation) ? m.cache_creation : 0;
    cacheRead += read;
    promptTotal += input + read + creation;
  }
  if (promptTotal <= 0) return null;
  return Math.round((100 * cacheRead) / promptTotal);
}

/**
 * Write a per-turn LLM-telemetry row (category='turn') to public_audit_trail.
 *
 * The honest unit is one query() call: the SDK resolves cost only per-turn
 * (no per-subagent/per-tool breakdown — subagent usage rolls up into the
 * parent result), so this row carries the turn's real model/tokens/cost/cache/
 * latency on a turn-level row, while the funnel/progress writers stay
 * untouched. The container's poll-loop fires it fire-and-forget on EVERY turn
 * (§24.55 lifted the original record_*-only gate so /live's spend is a total,
 * not a sample); registered owner-only, so a sandbox emission never lands a
 * row. Gated by the `telemetry_capture` preference (default true) — a kill
 * switch. `cache_read_pct` is derived here from the per-model usage; the
 * legacy boolean `cache_hit` keeps being written for back-compat.
 *
 * The row carries no free text (numbers + a fixed summary), so it needs no
 * sanitization and is exempt from the funnel-only resanitization hooks.
 */
export async function handleRecordTurnTelemetry(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  try {
    const db = getDb();

    // Kill switch — when telemetry_capture is off, ack without writing.
    if (!getConfig<boolean>(db, 'telemetry_capture', true)) {
      writeResponse(inDb, requestId, { ok: true, data: { skipped: true } });
      return;
    }

    const id = generateId('turn');
    const now = new Date().toISOString();
    const details = typeof p.details === 'object' && p.details ? (p.details as Record<string, unknown>) : {};
    db.prepare(
      `INSERT INTO public_audit_trail
         (id, seq, ts, category, agent_name, proactive, model_used, tokens, cost_cents, cache_hit, cache_read_pct, latency_ms, summary, details_json)
       VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail),
               @ts, 'turn', NULL, @proactive, @model_used, @tokens, @cost_cents, @cache_hit, @cache_read_pct, @latency_ms, @summary, @details_json)`,
    ).run({
      id,
      ts: now,
      proactive: deriveProactive(inDb) ? 1 : 0,
      model_used: typeof p.model_used === 'string' ? p.model_used : null,
      tokens: numOrNull(p.tokens),
      cost_cents: numOrNull(p.cost_cents),
      cache_hit: p.cache_hit === 1 || p.cache_hit === true ? 1 : 0,
      cache_read_pct: deriveCacheReadPct(details),
      latency_ms: numOrNull(p.latency_ms),
      summary: TURN_TELEMETRY_SUMMARY,
      details_json: JSON.stringify({ ...details, record_calls: numOrNull(p.record_calls) }),
    });

    writeResponse(inDb, requestId, { ok: true, data: { id } });
  } catch (err) {
    log.error('handleRecordTurnTelemetry failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── create_gmail_draft ─────────────────────────────────────────────────────

const STUB_DRAFT_PREFIX = 'stub-draft-';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_HARD_CAP = 8_000;

/**
 * Materialize a Gmail draft on the candidate's behalf. Reversible (no send) —
 * the candidate must explicitly send from Gmail. No approval gate; the future
 * `send_outreach_email` tool is the one that lands approval-gating per
 * PORTAL.md §6.3.
 *
 * Stub mode: when `process.env.GMAIL_STUB === '1'`, returns a synthetic
 * `draft_id` matching `/^stub-draft-/` without touching the Gmail API. The
 * e2e flow runs in stub mode; real Gmail integration is verified manually
 * post-DoD.
 *
 * Sandbox isolation (Phase 2.3 simplification): host-side group-folder check
 * refuses for any folder other than `career-pilot`. The spec's preferred
 * mechanism is `disallowedTools` removal from the SDK context (per AGENT_SDK_
 * PATTERNS.md §6) — wiring that requires a `disallowedTools` field through
 * the container-config → container.json → provider-options stack. Filed as
 * follow-up (see task tracker); for Phase 2.3 the host-side refusal
 * satisfies DoD #8 (sandbox returns a clear error rather than materializing
 * a draft).
 */
export async function handleCreateGmailDraft(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const to = p.to as string;
  const subject = p.subject as string;
  const body = p.body as string;
  const in_reply_to = (p.in_reply_to as string | null | undefined) ?? null;

  // Sandbox isolation: only the owner agent group can materialize Gmail drafts.
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message:
          'create_gmail_draft is not available in this agent group (sandbox sessions cannot materialize real Gmail drafts).',
      },
    });
    return;
  }

  if (!to || !EMAIL_RE.test(to)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'to must be a valid email address' },
    });
    return;
  }
  if (!subject || typeof subject !== 'string') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'subject is required (non-empty string)' },
    });
    return;
  }
  if (!body || typeof body !== 'string') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'body is required (non-empty string)' },
    });
    return;
  }
  if (body.length > BODY_HARD_CAP) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'BAD_ARGS',
        message: `body exceeds hard cap (${body.length} > ${BODY_HARD_CAP} chars). The prompt-level cap is ≤200 words — something went wrong upstream.`,
      },
    });
    return;
  }

  const stubMode = process.env.GMAIL_STUB === '1';
  if (stubMode) {
    const draft_id = `${STUB_DRAFT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const draft_url = `https://mail.google.com/mail/u/0/#drafts/${draft_id}`;
    log.info('create_gmail_draft (stub)', { to, subject, body_chars: body.length, draft_id });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { draft_id, draft_url, stub: true, in_reply_to },
    });
    return;
  }

  // Real Gmail integration — TODO Phase 3+ (full OAuth onboarding wizard).
  // For Phase 2.3, real-mode lands behind a stub call against the Gmail API
  // via OneCLI-vaulted OAuth refresh token (host-pattern www.googleapis.com).
  // Until manual OneCLI registration is done, this branch returns a clear
  // error rather than half-implementing.
  writeResponse(inDb, requestId, {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Real Gmail draft creation is not yet wired (Phase 3+). Run with GMAIL_STUB=1 for now.',
    },
  });
}

// ── update_application (UPSERT) ────────────────────────────────────────────

const APPLICATION_COLUMNS = [
  'company_name',
  'company_aliases',
  'obfuscated_label',
  'public_state',
  'role_title',
  'job_url',
  'jd_text',
  'jd_analyzed',
  'status',
  'win_confidence',
  'applied_at',
  'last_activity_at',
] as const;

const INSERT_REQUIRED = ['company_name', 'role_title', 'status'] as const;

// §24.11 Sub-milestone 4.3: the obfuscation-policy fields. A change to any
// of these invalidates an application's past public_audit_trail rows, so an
// UPDATE that moves one triggers retroactive resanitization. obfuscated_label
// is included for completeness but is immutable via this handler (excluded
// from the UPDATE set below) — out-of-band changes to it go through the
// operator script (scripts/resanitize-application.ts).
const OBFUSCATION_TRIGGER_FIELDS = ['company_name', 'company_aliases', 'obfuscated_label', 'public_state'] as const;

interface ObfuscationSnapshot {
  obfuscated_label: string;
  company_name: string | null;
  company_aliases: string | null;
  public_state: string | null;
}

function obfuscationPolicyChanged(before: ObfuscationSnapshot, after: ObfuscationSnapshot): boolean {
  return OBFUSCATION_TRIGGER_FIELDS.some((k) => before[k] !== after[k]);
}

export async function handleUpdateApplication(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const id = p.id as string;
  const patch = (p.patch as Record<string, unknown>) ?? {};
  warnUnknownStatus(patch.status, 'handleUpdateApplication');

  if (!id) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: 'id is required' } });
    return;
  }

  try {
    const db = getDb();
    const existing = db
      .prepare(
        'SELECT obfuscated_label, company_name, company_aliases, public_state, status FROM applications WHERE id = ?',
      )
      .get(id) as (ObfuscationSnapshot & { status: string | null }) | undefined;

    const now = new Date().toISOString();

    if (!existing) {
      // INSERT branch
      const missing = INSERT_REQUIRED.filter((k) => !patch[k]);
      if (missing.length > 0) {
        writeResponse(inDb, requestId, {
          ok: false,
          error: {
            code: 'BAD_ARGS',
            message: `INSERT requires fields: ${missing.join(', ')}`,
          },
        });
        return;
      }

      const industry = deriveIndustry(patch);
      const obfuscated_label = nextObfuscatedLabel(industry);

      db.prepare(
        `INSERT INTO applications (
          id, company_name, company_aliases, obfuscated_label, public_state,
          role_title, job_url, jd_text, jd_analyzed, status, win_confidence,
          applied_at, last_activity_at, created_at
        ) VALUES (
          @id, @company_name, @company_aliases, @obfuscated_label, @public_state,
          @role_title, @job_url, @jd_text, @jd_analyzed, @status, @win_confidence,
          @applied_at, @last_activity_at, @created_at
        )`,
      ).run({
        id,
        company_name: patch.company_name ?? null,
        company_aliases: patch.company_aliases ?? null,
        obfuscated_label,
        public_state: patch.public_state ?? 'obfuscated',
        role_title: patch.role_title ?? null,
        job_url: patch.job_url ?? null,
        jd_text: patch.jd_text ?? null,
        jd_analyzed: patch.jd_analyzed ?? null,
        status: patch.status ?? null,
        win_confidence: patch.win_confidence ?? null,
        applied_at: patch.applied_at ?? null,
        last_activity_at: now,
        created_at: now,
      });

      log.info('Application created', { id, obfuscated_label });
      writeResponse(inDb, requestId, {
        ok: true,
        data: { id, created: true, obfuscated_label },
      });
      upsertPublicFunnelView(db, id);
      // §24.53: a new application created straight into an interview stage
      // (rare, but possible) should still get a kit.
      if (patch.status) {
        reactToStatusTransitions(db, inDb, [{ application_id: id, from: null, to: String(patch.status) }]);
      }
      return;
    }

    // UPDATE branch — only fields present in patch
    const updatable = APPLICATION_COLUMNS.filter(
      (k) => k !== 'obfuscated_label' && Object.prototype.hasOwnProperty.call(patch, k),
    );
    if (updatable.length === 0) {
      // No-op update — still bump last_activity_at and respond OK.
      db.prepare('UPDATE applications SET last_activity_at = @now WHERE id = @id').run({ id, now });
      writeResponse(inDb, requestId, {
        ok: true,
        data: { id, created: false, obfuscated_label: existing.obfuscated_label },
      });
      upsertPublicFunnelView(db, id);
      return;
    }

    const setClause = updatable.map((k) => `${k} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id, last_activity_at: now };
    for (const k of updatable) {
      params[k] = patch[k] ?? null;
    }
    db.prepare(`UPDATE applications SET ${setClause}, last_activity_at = @last_activity_at WHERE id = @id`).run(params);

    log.info('Application updated', { id, fields: updatable });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { id, created: false, obfuscated_label: existing.obfuscated_label },
    });

    // §24.11 Sub-milestone 4.3 — retroactive resanitization. Runs AFTER
    // writeResponse so re-mirror latency never blocks the agent's MCP call,
    // and is wrapped in try/catch (same shape as the 4.1 mirror hook):
    // failure is logged, never propagated, never rolls back the UPDATE.
    // Gated on the obfuscation-policy fields actually changing (before/after
    // snapshot diff — robust to obfuscated_label being immutable here) and
    // on the operator preference.
    const after = db
      .prepare('SELECT obfuscated_label, company_name, company_aliases, public_state FROM applications WHERE id = ?')
      .get(id) as ObfuscationSnapshot | undefined;
    const policyChanged = !!after && obfuscationPolicyChanged(existing, after);

    if (policyChanged && getConfig<boolean>(db, 'sanitization_resanitize_on_application_update')) {
      try {
        await resanitizeApplicationAuditTrail(db, id);
      } catch (resanErr) {
        log.error('resanitizeApplicationAuditTrail threw despite internal try/catch', {
          id,
          resanErr,
        });
      }
    }

    // §24.65: a policy flip changes which kit sections the dossier read-model
    // may show — re-project BOTH directions (reveal → sections fill in;
    // un-reveal → identifying sections seal again). Gated on the policy
    // actually changing (re-projection runs Pass 3 over safe sections);
    // ordinary kit writes re-project themselves in interview-kit-actions.
    if (policyChanged) {
      await upsertPublicKitView(db, id);
    }

    // Refresh the public funnel read-model (application_ref / stage / activity
    // may have changed). Best-effort; the function catches + never throws.
    upsertPublicFunnelView(db, id);

    // §24.53: an agent-driven status move into an interview stage enqueues a kit
    // wake; into a terminal stage archives kits. Only when status actually changed.
    if (patch.status && updatable.includes('status') && patch.status !== existing.status) {
      reactToStatusTransitions(db, inDb, [
        { application_id: id, from: existing.status ?? null, to: String(patch.status) },
      ]);
    }
  } catch (err) {
    log.error('handleUpdateApplication failed', { id, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Derive an industry slug for the obfuscated_label. Phase 1 has no
 * analyze_jd, so we accept industry from patch.jd_analyzed.role_category
 * if present, otherwise fall back to 'misc'. Industry-aware labelling
 * matures in Phase 2 when analyze_jd lands.
 */
function deriveIndustry(patch: Record<string, unknown>): string {
  try {
    if (typeof patch.jd_analyzed === 'string') {
      const parsed = JSON.parse(patch.jd_analyzed) as { role_category?: string };
      if (parsed.role_category) return slugify(parsed.role_category);
    }
  } catch {
    /* ignore */
  }
  return 'misc';
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'misc'
  );
}

/**
 * Generate the next obfuscated_label for an industry: industry-a, industry-b,
 * ... industry-z, industry-aa, industry-ab, ... Deterministic for a given
 * existing-label set, so independent callers concurrent on the same industry
 * are not safe — but UPSERTs are serialized through the host's single-writer
 * connection so we don't worry about it.
 */
export function nextObfuscatedLabel(industry: string): string {
  const rows = getDb()
    .prepare('SELECT obfuscated_label FROM applications WHERE obfuscated_label LIKE ?')
    .all(`${industry}-%`) as Array<{ obfuscated_label: string }>;
  const used = new Set(rows.map((r) => r.obfuscated_label.split(/-(.+)/)[1]).filter(Boolean));
  let n = 0;
  while (true) {
    const suffix = encodeSuffix(n);
    if (!used.has(suffix)) return `${industry}-${suffix}`;
    n++;
  }
}

/** 0 → 'a', 1 → 'b', ..., 25 → 'z', 26 → 'aa', 27 → 'ab', ... */
function encodeSuffix(n: number): string {
  let s = '';
  n = Math.max(0, Math.floor(n));
  while (true) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    if (n < 26) return s;
    n = Math.floor(n / 26) - 1;
  }
}

// ── record_funnel_event ────────────────────────────────────────────────────

export async function handleRecordFunnelEvent(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const application_id = p.application_id as string;
  const kind = p.kind as string;
  const payloadJson = p.payload as Record<string, unknown> | undefined;
  const from_status = (p.from_status as string | null) ?? null;
  const to_status = (p.to_status as string | null) ?? null;
  warnUnknownStatus(to_status, 'handleRecordFunnelEvent');

  if (!application_id || !kind || !payloadJson) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'application_id, kind, and payload are required' },
    });
    return;
  }

  try {
    const db = getDb();
    const appExists = db.prepare('SELECT 1 FROM applications WHERE id = ?').get(application_id);
    if (!appExists) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: { code: 'NOT_FOUND', message: `no application with id "${application_id}"` },
      });
      return;
    }

    const event_id = generateId('fe');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO funnel_events
         (id, application_id, kind, from_status, to_status, payload, source, proactive, ts)
       VALUES (@id, @application_id, @kind, @from_status, @to_status, @payload, 'agent', @proactive, @ts)`,
    ).run({
      id: event_id,
      application_id,
      kind,
      from_status,
      to_status,
      payload: JSON.stringify(payloadJson),
      proactive: deriveProactive(inDb) ? 1 : 0,
      ts: now,
    });
    // Bump the application's last_activity_at to match.
    db.prepare('UPDATE applications SET last_activity_at = @ts WHERE id = @id').run({
      id: application_id,
      ts: now,
    });

    log.info('Funnel event recorded', { event_id, application_id, kind });
    writeResponse(inDb, requestId, { ok: true, data: { event_id } });

    // Phase 4 §24.10 public mirror. Runs after writeResponse so mirror
    // latency never blocks the agent's MCP call. Errors are logged and
    // swallowed — the private write is committed regardless.
    try {
      await mirrorFunnelEvent(db, event_id);
    } catch (mirrorErr) {
      log.error('mirrorFunnelEvent threw despite internal try/catch', { event_id, mirrorErr });
    }

    // Refresh the public funnel read-model (status / stage_entered_at /
    // last_activity_at changed). Best-effort; the function never throws.
    upsertPublicFunnelView(db, application_id);
  } catch (err) {
    log.error('handleRecordFunnelEvent failed', { application_id, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── get_application ────────────────────────────────────────────────────────

export async function handleGetApplication(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const id = p.id as string;

  if (!id) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: 'id is required' } });
    return;
  }

  try {
    const row = getDb().prepare('SELECT * FROM applications WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    writeResponse(inDb, requestId, { ok: true, data: { application: row ?? null } });
  } catch (err) {
    log.error('handleGetApplication failed', { id, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── list_applications ──────────────────────────────────────────────────────

export async function handleListApplications(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const status = p.status as string | null;
  const limitRaw = p.limit as number | null;
  const limit = limitRaw && limitRaw > 0 && limitRaw <= 200 ? Math.floor(limitRaw) : 50;

  try {
    let rows: Array<Record<string, unknown>>;
    if (status) {
      rows = getDb()
        .prepare(
          'SELECT * FROM applications WHERE status = ? ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?',
        )
        .all(status, limit) as Array<Record<string, unknown>>;
    } else {
      rows = getDb()
        .prepare('SELECT * FROM applications ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?')
        .all(limit) as Array<Record<string, unknown>>;
    }
    writeResponse(inDb, requestId, { ok: true, data: { applications: rows } });
  } catch (err) {
    log.error('handleListApplications failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// Exported for unit testing.
export const _testing = { encodeSuffix, slugify, deriveIndustry, normalizeProfileValue };
