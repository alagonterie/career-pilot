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

import { companyFromEmail, mintLink } from '../../attribution.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import { projectWorkProfile } from '../portal/profile.js';
import { setSimulatorColdEmail, setSimulatorTailoredProfile } from '../portal/simulator.js';
import {
  OWNER_APPLIED_EVENT_KIND,
  OWNER_EVENT_SOURCE,
  mirrorPipelineEvent,
  publicApplicationRef,
  resanitizeApplicationAuditTrail,
} from '../portal/public-audit.js';
import { sanitize, sanitizeForPublic } from '../portal/sanitizer.js';
import { pass3Active } from '../portal/sanitizer-pass3.js';
import { isKnownApplicationStatus, upsertPublicPipelineView } from '../portal/public-pipeline-view.js';
import { upsertPublicKitView } from '../portal/public-kit-view.js';
import { priceTokensMicrousd, recordRequestTelemetry, type TrafficClass } from '../../request-telemetry.js';
import type { Session } from '../../types.js';

import { reactToStatusTransitions } from './interview-kit-trigger.js';
import { classifyJobIndustry } from './job-classify.js';
import { normCompany, normText } from './lead-promotion.js';
import { isOpsSession } from './ops-session.js';
import { validateProactivePref } from './quiet-hours.js';
import { isClosedStatus, scoreWinConfidence, zeroClosedApplications } from './win-confidence.js';

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
 * status. The pipeline read-model's derivePipelineStage handles unknowns gracefully.
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

// ── emit_tailored_resume (sandbox structured tailored résumé, §24.144) ──────
//
// Registered PLAIN (not behind the owner gate): the sandbox is the intended
// caller, and the handler is sandbox-safe BY CONSTRUCTION — it touches no
// private candidate data, only stashes the agent's tailored profile into its
// OWN in-flight simulator run (resolved by session.thread_id == the run id),
// where persistRun runs it through the honesty guardrail before it can render.
// For the owner group there is no simulator run on the thread, so it no-ops
// (stored:false). The agent's tool handler already rejected a stub bio, so a
// valid payload arriving here is complete by the time we see it.
export async function handleEmitTailoredResume(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const profile = payload(content).profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    writeResponse(inDb, reqId(content), {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'emit_tailored_resume requires a profile object.' },
    });
    return;
  }
  const runId = session.thread_id;
  const stored = runId ? setSimulatorTailoredProfile(runId, profile) : false;
  writeResponse(inDb, reqId(content), { ok: true, data: { stored } });
}

// ── emit_cold_email (sandbox structured cold-outreach gift, §24.146) ────────
//
// Twin of handleEmitTailoredResume: registered PLAIN, sandbox-safe by
// construction (writes only the caller's own in-flight simulator run, resolved
// by session.thread_id == the run id; no private candidate state). The agent's
// tool handler already rejected a stub subject/body, so a valid payload here is
// complete. No-op (stored:false) when there's no run for the thread.
export async function handleEmitColdEmail(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const p = payload(content);
  const subject = typeof p.subject === 'string' ? p.subject.trim() : '';
  const body = typeof p.body === 'string' ? p.body.trim() : '';
  if (!subject || !body) {
    writeResponse(inDb, reqId(content), {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'emit_cold_email requires a non-empty subject and body.' },
    });
    return;
  }
  const runId = session.thread_id;
  const stored = runId ? setSimulatorColdEmail(runId, subject, body) : false;
  writeResponse(inDb, reqId(content), { ok: true, data: { stored } });
}

// ── update_profile_field ───────────────────────────────────────────────────

export const PROFILE_FIELDS = new Set([
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
  'public_email',
  'search_goals',
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
// protected_terms (§24.134d) is array-shaped too — it isn't a PROFILE_FIELDS
// onboarding step (the agent can't set it), but the /admin Persona editor
// (§24.170) routes it through normalizeProfileValue, so it must coerce as an array.
const ARRAY_PROFILE_FIELDS = new Set(['target_roles', 'skills', 'protected_terms']);
const NUMBER_PROFILE_FIELDS = new Set(['comp_floor']);
const OBJECT_PROFILE_FIELDS = new Set(['location_pref']);
// §24.188: month-granularity date columns, stored as a bare `YYYY-MM` — the same
// granularity the surface renders, so there's no day/timezone boundary to get
// wrong between the SSR seed and the client. Like protected_terms this is an
// owner-only Persona field (not a PROFILE_FIELDS onboarding step), but the
// /admin editor routes it through here, so it must coerce.
const MONTH_PROFILE_FIELDS = new Set(['searching_since']);

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
 * Coerce an owner-supplied month to a canonical `YYYY-MM`, or null (§24.188).
 * Accepts `2026-08`, `2026-08-01`, a full ISO timestamp, and `2026/8`; anything
 * unparseable stores as NULL rather than a string that would render as
 * "Invalid Date" on the public hero. Month-only by design — no day means no
 * local-vs-UTC boundary to disagree about.
 */
export function coerceMonth(value: unknown): string | null {
  if (typeof value === 'number') return null;
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})[-/](\d{1,2})/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || year < 1900 || year > 2999) return null;
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Normalize an `update_profile_field` value to its column's storage form before
 * binding: array fields → JSON-array text, comp_floor → a number, location_pref
 * → JSON-object text, month fields → `YYYY-MM`, everything else → a string (or
 * null). Defensive against however the agent serialized the value.
 */
export function normalizeProfileValue(field: string, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (ARRAY_PROFILE_FIELDS.has(field)) return JSON.stringify(coerceStringArray(value));
  if (MONTH_PROFILE_FIELDS.has(field)) return coerceMonth(value);
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

// ── set_work_profile (the composed /work page, §24.71 9.4b-2) ──────────────
//
// The agent's write path for the auto-composed /work page (+ landing hero). The
// composer maps the candidate's master_resume + basics into the WorkProfile
// shape (D2) and publishes it here; `GET /api/profile` projects it at read-time.
// Validated through the SAME `projectWorkProfile` the API reads with — so a
// stored blob always renders, and a malformed/nameless compose is rejected
// before it lands (the D5 minimum bar). Stamped `source='agent'` for the on-page
// provenance marker (D4). Owner-only; reversible (a re-compose overwrites).
export async function handleSetWorkProfile(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  // Accept either a structured object or a JSON string; project to the canonical
  // shape (drops unknown fields, coerces, requires a non-empty name).
  const raw = typeof p.profile === 'string' ? p.profile : JSON.stringify(p.profile ?? null);
  const projected = projectWorkProfile(raw);
  if (!projected) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'BAD_ARGS',
        message:
          'profile must be a WorkProfile object with a non-empty name. Compose it from the real master resume; omit (do not pad) sections you lack source for.',
      },
    });
    return;
  }

  const now = new Date().toISOString();
  try {
    const db = getDb();
    db.prepare(`INSERT INTO candidate_profile (id, updated_at) VALUES (1, @updated_at) ON CONFLICT(id) DO NOTHING`).run(
      {
        updated_at: now,
      },
    );
    db.prepare(
      `UPDATE candidate_profile
          SET work_profile_json = @json, work_profile_source = 'agent',
              work_profile_generated_at = @now, updated_at = @now
        WHERE id = 1`,
    ).run({ json: JSON.stringify(projected), now });

    log.info('candidate_profile work page composed', { name: projected.name });
    writeResponse(inDb, requestId, { ok: true, data: { name: projected.name } });
  } catch (err) {
    log.error('handleSetWorkProfile failed', { err });
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
export const PROGRESS_PER_SESSION_CAP = 6;
// §24.154: the cap counts only `record_progress` rows inside this recent window,
// NOT the session's whole lifetime. The original per-session count assumed
// short-lived (~5 min) sessions as a "per-run" proxy — true for owner/chat
// sessions, but the §24.67 *ops* session is one synthetic session alive for days,
// so a lifetime count accumulated past the cap (box: 10–11 rows) and then
// silently RATE_LIMITED every scheduled subagent's traces. A run's burst lands
// inside minutes; the scheduled dispatches are hours apart — so a 15-min window
// bounds one run yet resets between dispatches, restoring the per-run intent.
const PROGRESS_RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * INSERT one `subagent_progress` row into the public mirror. `seq = MAX+1` under
 * the host's single synchronous writer (§24.14). When the call attributed
 * itself to an application (§24.61), `applicationRef` is the HOST-derived
 * public label and `applicationId` rides details_json (server-side only —
 * /api/activity never delivers details_json) so policy flips can re-derive.
 */
/**
 * §24.78 / §24.77: the public-facing subagent name. The `prep-interview` subagent
 * definition still carries its pre-rename id; the portal renamed it (§24.53) and
 * the FE display alias was retired (§24.77) — so the canonical name is applied at
 * the single write point (`insertProgressRow`) for BOTH the model-driven
 * `record_progress` rows and the deterministic §24.78 lifecycle rows. The former
 * pipeline-scribe (legacy `funnel-curator`) entry was dropped in §24.152: migration
 * 137 migrated its audit data and the series-id was renamed, so no live dispatch
 * produces the legacy id.
 */
const SUBAGENT_DISPLAY_NAME: Record<string, string> = {
  'prep-interview': 'build-interview-kit',
};
export function publicSubagentName(subagentType: string): string {
  return SUBAGENT_DISPLAY_NAME[subagentType] ?? subagentType;
}

/**
 * §24.78: the fixed, PII-free summary on a deterministic subagent-lifecycle row.
 * The row's INFORMATION is the agent_name (which subagent ran); the summary is a
 * constant so it needs no sanitization. The model's own `record_progress` rows
 * (when it bothers to call it) still layer richer stage detail alongside.
 */
const SUBAGENT_DISPATCH_SUMMARY = 'Dispatched by the orchestrator.';

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
    agentName: publicSubagentName(args.agentName),
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
 * `record_dispatch` (§24.134c): the deterministic subagent-lifecycle trace,
 * emitted by the container the MOMENT the orchestrator's `Task` tool_use is
 * observed — not reconstructed at turn-end like §24.78 originally did. Writing
 * it here, before the subagent's own record_progress rows arrive, gives it a
 * lower seq, so the public `/live` trace reads "▸ dispatched X" THEN X's
 * progress (instead of the marker landing after the work). Carries only the
 * public-safe subagent name + the fixed summary, so it needs no sanitization.
 * Sandbox is excluded both ways: the container gates emission on the owner path,
 * and this handler also skips the sandbox traffic class (defense in depth).
 */
export async function handleRecordDispatch(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  try {
    const subagentType = typeof p.subagent_name === 'string' ? p.subagent_name.trim() : '';
    if (subagentType && deriveTrafficClass(session) !== 'sandbox') {
      const db = getDb();
      if (getConfig<boolean>(db, 'owner_subagent_trace_emit_enabled', true)) {
        insertProgressRow(db, {
          id: generateId('prog'),
          ts: new Date().toISOString(),
          agentName: subagentType,
          proactive: 0,
          summary: SUBAGENT_DISPATCH_SUMMARY,
          stage: 'dispatched',
          sessionId: session.id,
          applicationRef: null,
          applicationId: null,
        });
      }
    }
    writeResponse(inDb, requestId, { ok: true, data: { recorded: true } });
  } catch (err) {
    log.error('record_dispatch failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
    });
  }
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

    // Per-(session, subagent) soft rate-limit, scoped to a recent WINDOW so it
    // approximates "per-run" without assuming short-lived sessions (§24.154 — the
    // long-lived §24.67 ops session broke the old lifetime count). Excludes the
    // deterministic dispatch-marker rows (they're written by handleRecordDispatch,
    // not a real record_progress call, so they must not consume the cap). Spec
    // calls for 7th-call rejection (cap=6 prior).
    const sessionLike = `%"session_id":"${session.id}"%`;
    const windowStart = new Date(Date.now() - PROGRESS_RATE_WINDOW_MS).toISOString();
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM public_audit_trail
            WHERE category = 'subagent_progress'
              AND agent_name = @agent
              AND details_json LIKE @sessionLike
              AND summary <> @dispatchSummary
              AND ts >= @windowStart`,
        )
        .get({
          agent: subagent_name,
          sessionLike,
          dispatchSummary: SUBAGENT_DISPATCH_SUMMARY,
          windowStart,
        }) as { n: number }
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
 * Traffic class for a container-issued request (§24.68 D4), derived HOST-side
 * from the session in hand — never from the container payload (trust
 * boundary): sandbox group → 'sandbox'; the owner ops session → 'ops';
 * otherwise the owner chat session → 'chat'.
 */
function deriveTrafficClass(session: Session): TrafficClass {
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') return 'sandbox';
  return isOpsSession(session) ? 'ops' : 'chat';
}

/**
 * Sum the per-model usage map the container forwards in `details.model_usage`
 * into the four token lanes for the request_telemetry row. Missing/garbage
 * lanes stay null (unknown ≠ 0).
 */
function sumModelUsage(details: Record<string, unknown>): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
} {
  const usage = details.model_usage;
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
  }
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let any = false;
  for (const u of Object.values(usage as Record<string, unknown>)) {
    if (!u || typeof u !== 'object') continue;
    const m = u as { input?: unknown; output?: unknown; cache_read?: unknown; cache_creation?: unknown };
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    input += n(m.input);
    output += n(m.output);
    cacheRead += n(m.cache_read);
    cacheCreation += n(m.cache_creation);
    any = true;
  }
  if (!any) return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation };
}

/**
 * Write a per-turn LLM-telemetry row (category='turn') to public_audit_trail,
 * plus a private request_telemetry row (§24.68 dual-write).
 *
 * The honest unit is one query() call: the SDK resolves cost only per-turn
 * (no per-subagent/per-tool breakdown — subagent usage rolls up into the
 * parent result), so this row carries the turn's real model/tokens/cost/cache/
 * latency on a turn-level row, while the pipeline/progress writers stay
 * untouched. The container's poll-loop fires it fire-and-forget on EVERY turn
 * (§24.55 lifted the original record_*-only gate so /live's spend is a total,
 * not a sample). Gated by the `telemetry_capture` preference (default true) —
 * a kill switch. `cache_read_pct` is derived here from the per-model usage;
 * the legacy boolean `cache_hit` keeps being written for back-compat.
 *
 * Registration is PLAIN (not owner-only) since §24.68 D-C: a sandbox emission
 * writes a private request_telemetry row (traffic_class 'sandbox') and NEVER
 * the public_audit_trail row — the "sandbox never lands a public row"
 * invariant now lives in the branch below, pinned by an integration test.
 *
 * The public row carries no free text (numbers + a fixed summary), so it
 * needs no sanitization and is exempt from the pipeline-only resanitization hooks.
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

    const trafficClass = deriveTrafficClass(session);
    const now = new Date().toISOString();
    const details = typeof p.details === 'object' && p.details ? (p.details as Record<string, unknown>) : {};

    let id: string | null = null;
    if (trafficClass !== 'sandbox') {
      // §24.78's deterministic subagent-lifecycle trace used to be reconstructed
      // HERE from p.subagent_dispatches — but at turn-end it always took the
      // turn's highest seq, so the "Dispatched by the orchestrator." row landed
      // AFTER the subagent's own mid-turn record_progress rows. §24.134c moves
      // the emission to dispatch-OBSERVATION time (the container's `dispatch`
      // ProviderEvent → record_dispatch → handleRecordDispatch), giving it a
      // lower seq so it reads as a header for the work that follows. The turn
      // telemetry still carries subagent_dispatches in details for data, but no
      // longer writes the lifecycle rows.

      id = generateId('turn');
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
    }

    // §24.68 dual-write: the ops-grade per-request row. SDK cost arrives as
    // cents — convert to microUSD (×10,000). Best-effort by construction
    // (recordRequestTelemetry never throws).
    const usage = sumModelUsage(details);
    const costCents = numOrNull(p.cost_cents);
    recordRequestTelemetry({
      provider: 'portkey',
      surface: 'agent-turn',
      trafficClass,
      ok: true,
      latencyMs: numOrNull(p.latency_ms) ?? 0,
      sessionId: session.id,
      model: typeof p.model_used === 'string' ? p.model_used : null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costMicrousd: costCents != null ? costCents * 10_000 : null,
      details: { num_turns: numOrNull((details as { num_turns?: unknown }).num_turns) },
    });

    writeResponse(inDb, requestId, { ok: true, data: id ? { id } : { recorded: true } });
  } catch (err) {
    log.error('handleRecordTurnTelemetry failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── record_request_telemetry ────────────────────────────────────────────────

const TELEMETRY_SLUG_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * Land a container-side request-telemetry report (§24.68): rank-leads Haiku,
 * SerpApi search, pipeline-scribe Gmail/Calendar fetches. Registered PLAIN —
 * the row is private, numbers-only, and classed host-side (deriveTrafficClass),
 * so a sandbox emission is safe by construction. provider/surface are
 * validated as slugs; cost is priced here from tokens+model — the container
 * never prices itself.
 */
export async function handleRecordRequestTelemetry(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  try {
    const db = getDb();

    if (!getConfig<boolean>(db, 'telemetry_capture', true)) {
      writeResponse(inDb, requestId, { ok: true, data: { skipped: true } });
      return;
    }

    const provider = typeof p.provider === 'string' ? p.provider : '';
    const surface = typeof p.surface === 'string' ? p.surface : '';
    if (!TELEMETRY_SLUG_RE.test(provider) || !TELEMETRY_SLUG_RE.test(surface)) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: { code: 'BAD_ARGS', message: 'provider and surface must be [a-z0-9_-]{1,64} slugs' },
      });
      return;
    }

    const model = typeof p.model === 'string' ? p.model : null;
    const tokens = {
      inputTokens: numOrNull(p.input_tokens),
      outputTokens: numOrNull(p.output_tokens),
      cacheReadTokens: numOrNull(p.cache_read_tokens),
      cacheCreationTokens: numOrNull(p.cache_creation_tokens),
    };
    recordRequestTelemetry({
      provider,
      surface,
      trafficClass: deriveTrafficClass(session),
      ok: p.ok === true || p.ok === 1,
      latencyMs: numOrNull(p.latency_ms) ?? 0,
      statusCode: numOrNull(p.status_code),
      sessionId: session.id,
      model,
      ...tokens,
      costMicrousd: priceTokensMicrousd(db, model, tokens),
      error: typeof p.error === 'string' && p.error ? p.error : null,
      details: typeof p.details === 'object' && p.details ? (p.details as Record<string, unknown>) : null,
    });

    writeResponse(inDb, requestId, { ok: true, data: { recorded: true } });
  } catch (err) {
    log.error('handleRecordRequestTelemetry failed', { err });
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

  // §24.74: if the body carries the portal URL (the attribution footer the
  // orchestrator appends), mint a per-company outreach token and route that link
  // through `/r/<code>`, so a recruiter's click attributes to the company we
  // emailed (the recipient's domain is the key). Best-effort: a miss (no portal
  // URL in the body, or a mint failure) leaves the body untouched.
  let outBody = body;
  const portalUrl = getConfig<string>(getDb(), 'portal_public_url', '');
  if (portalUrl && outBody.includes(portalUrl)) {
    const minted = mintLink({ artifactType: 'outreach', company: companyFromEmail(to), recipient: to });
    if (minted) outBody = outBody.replace(portalUrl, portalUrl.replace(/\/$/, '') + minted.path);
  }

  const stubMode = process.env.GMAIL_STUB === '1';
  if (stubMode) {
    const draft_id = `${STUB_DRAFT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const draft_url = `https://mail.google.com/mail/u/0/#drafts/${draft_id}`;
    log.info('create_gmail_draft (stub)', { to, subject, body_chars: outBody.length, draft_id });
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

const WRITABLE_APPLICATION_COLUMNS: ReadonlySet<string> = new Set(APPLICATION_COLUMNS);

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

    // §24.199: patch keys this handler does not write (scorer-owned
    // win_confidence_rationale, the immutable obfuscated_label, typos). Reported
    // back so the caller is never told `ok` about a field that did not land.
    const ignoredFields = Object.keys(patch).filter(
      (k) => k === 'obfuscated_label' || !WRITABLE_APPLICATION_COLUMNS.has(k),
    );

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

      let industry = deriveIndustry(patch);
      // §6.2 belt: the agent often omits jd_analyzed on a quick "I applied to X"
      // add → deriveIndustry returns 'misc'. Land the deferred analyze_jd
      // host-side: classify the company's industry from the JD so the public
      // handle stays meaningful (health-a) instead of misc-a. Best-effort; keeps
      // 'misc' on miss (no Portkey / failure).
      if (industry === 'misc' && typeof patch.jd_text === 'string' && patch.jd_text.trim().length > 0) {
        const inferred = await classifyJobIndustry(patch.jd_text, patch.role_title);
        if (inferred) industry = inferred;
      }
      const { obfuscated_label } = insertApplicationCore(db, {
        id,
        industry,
        now,
        company_name: patch.company_name,
        company_aliases: patch.company_aliases,
        public_state: patch.public_state,
        role_title: patch.role_title,
        job_url: patch.job_url,
        jd_text: patch.jd_text,
        jd_analyzed: patch.jd_analyzed,
        status: patch.status,
        win_confidence: patch.win_confidence,
        applied_at: patch.applied_at,
      });

      log.info('Application created', { id, obfuscated_label });
      writeResponse(inDb, requestId, {
        ok: true,
        data: { id, created: true, obfuscated_label, ignored_fields: ignoredFields },
      });
      upsertPublicPipelineView(db, id);
      // §24.53: a new application created straight into an interview stage
      // (rare, but possible) should still get a kit.
      if (patch.status) {
        reactToStatusTransitions(db, inDb, [{ application_id: id, from: null, to: String(patch.status) }]);
      }
      // §24.195: the scorer is the only writer of win_confidence_rationale and
      // otherwise runs only after a pipeline-scribe persist, so a new
      // application showed a bare score (or none) until unrelated mail arrived.
      // Fire-and-forget, after the response — never blocks or fails the create.
      void scoreWinConfidence(db).catch((scoreErr) => {
        log.error('scoreWinConfidence after application create failed', { scoreErr });
      });
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
        data: { id, created: false, obfuscated_label: existing.obfuscated_label, ignored_fields: ignoredFields },
      });
      upsertPublicPipelineView(db, id);
      return;
    }

    const setClause = updatable.map((k) => `${k} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id, last_activity_at: now };
    for (const k of updatable) {
      params[k] = patch[k] ?? null;
    }
    db.prepare(`UPDATE applications SET ${setClause}, last_activity_at = @last_activity_at WHERE id = @id`).run(params);

    // §24.199: a closed application settles at 0 + the closed rationale NOW —
    // deterministic, before the response, so a read-back in the same turn sees
    // it. Runs whenever the resulting status is closed (not only on the
    // transition), which also repairs a row closed before this existed.
    const statusChanged = updatable.includes('status') && patch.status !== existing.status;
    const resultingStatus = updatable.includes('status') ? patch.status : existing.status;
    if (isClosedStatus(resultingStatus)) zeroClosedApplications(db);

    log.info('Application updated', { id, fields: updatable, ignored: ignoredFields });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { id, created: false, obfuscated_label: existing.obfuscated_label, ignored_fields: ignoredFields },
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

    // Refresh the public pipeline read-model (application_ref / stage / activity
    // may have changed). Best-effort; the function catches + never throws.
    upsertPublicPipelineView(db, id);

    // §24.53: an agent-driven status move into an interview stage enqueues a kit
    // wake; into a terminal stage archives kits. Only when status actually changed.
    if (patch.status && statusChanged) {
      reactToStatusTransitions(db, inDb, [
        { application_id: id, from: existing.status ?? null, to: String(patch.status) },
      ]);
      // §24.199: a stage move among live statuses is momentum evidence, and a
      // re-opened application must not keep the closed rationale — re-score.
      // Fire-and-forget, after the response (as the create branch does).
      if (!isClosedStatus(patch.status)) {
        void scoreWinConfidence(db).catch((scoreErr) => {
          log.error('scoreWinConfidence after status change failed', { scoreErr });
        });
      }
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
export function nextObfuscatedLabel(industry: string, db: Database.Database = getDb()): string {
  const rows = db
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

// ── Application insert core (§24.202 D8) ─────────────────────────────────────

/** The fields one new `applications` row is built from. Values are stored as
 * given (`?? null`) — the agent path passes its raw patch through unchanged. */
export interface ApplicationInsert {
  id: string;
  /** Industry slug the obfuscated label is allocated under ('misc' fallback). */
  industry: string;
  /** ISO timestamp for created_at / last_activity_at. */
  now: string;
  company_name?: unknown;
  company_aliases?: unknown;
  public_state?: unknown;
  role_title?: unknown;
  job_url?: unknown;
  jd_text?: unknown;
  jd_analyzed?: unknown;
  status?: unknown;
  win_confidence?: unknown;
  applied_at?: unknown;
  /** Which tailored résumé went out (migration 150). Only the /admin path sets it. */
  sent_resume_id?: string | null;
}

/**
 * The synchronous half of creating an application, shared by the agent's
 * `update_application` INSERT branch and the `/admin` "I applied" action
 * (§24.202 D8): allocate the obfuscated label from the one allocator (a host
 * path that skipped it would ship a label-less row and disable redaction) and
 * insert the row. No classification (async — the caller does it first), no
 * response writing, no post-commit hooks. Safe inside a `db.transaction`. Throws
 * on a DB error like any statement; callers own the catch.
 */
export function insertApplicationCore(db: Database.Database, input: ApplicationInsert): { obfuscated_label: string } {
  const obfuscated_label = nextObfuscatedLabel(input.industry, db);
  const withResume = input.sent_resume_id != null;
  db.prepare(
    `INSERT INTO applications (
      id, company_name, company_aliases, obfuscated_label, public_state,
      role_title, job_url, jd_text, jd_analyzed, status, win_confidence,
      applied_at, last_activity_at, created_at${withResume ? ', sent_resume_id' : ''}
    ) VALUES (
      @id, @company_name, @company_aliases, @obfuscated_label, @public_state,
      @role_title, @job_url, @jd_text, @jd_analyzed, @status, @win_confidence,
      @applied_at, @last_activity_at, @created_at${withResume ? ', @sent_resume_id' : ''}
    )`,
  ).run({
    id: input.id,
    company_name: input.company_name ?? null,
    company_aliases: input.company_aliases ?? null,
    obfuscated_label,
    public_state: input.public_state ?? 'obfuscated',
    role_title: input.role_title ?? null,
    job_url: input.job_url ?? null,
    jd_text: input.jd_text ?? null,
    jd_analyzed: input.jd_analyzed ?? null,
    status: input.status ?? null,
    win_confidence: input.win_confidence ?? null,
    applied_at: input.applied_at ?? null,
    last_activity_at: input.now,
    created_at: input.now,
    ...(withResume ? { sent_resume_id: input.sent_resume_id } : {}),
  });
  return { obfuscated_label };
}

// ── /admin "I applied" + undo (§24.202 D8) ───────────────────────────────────
//
// The Leads tab's one-click "I applied": create the application AND link the
// clicked lead in one step, instead of telling the agent. Owner-only — routed
// from the /admin leads write, which is gated by adminEnabled() upstream.

/** An /admin write outcome (same shape as admin.ts's sync writers). */
export interface AdminWriteOutcome {
  status: number;
  body: unknown;
}

/** The LLM calls the action makes, injectable so tests never touch the network. */
export interface AppliedFromLeadDeps {
  classify?: (jdText: string, roleTitle?: unknown) => Promise<string | null>;
  scoreWinConfidence?: (db: Database.Database) => Promise<unknown>;
  now?: () => Date;
}

/** The pipeline_events kind/source of the owner's "I applied" record. It carries
 * the note and the lead's prior state (what undo restores). Owner-sourced and
 * never mirrored to the public audit trail — `mirrorPipelineEvent` refuses them,
 * so a later re-sanitize cannot publish the note either. Defined next to that
 * filter; re-exported here for the callers of this module. */
export { OWNER_APPLIED_EVENT_KIND, OWNER_EVENT_SOURCE };

/** Cap on the owner's free-text note — the `owner_note_max_chars` knob. */
function ownerNoteMaxChars(db: Database.Database): number {
  const n = Math.floor(Number(getConfig<number>(db, 'owner_note_max_chars', 2000)));
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/** Statuses that make an application no longer "open" for the duplicate check —
 * the same closed set the win-confidence scorer zeroes. */
const CLOSED_APPLICATION_STATUSES = new Set(['REJECTED', 'WITHDRAWN']);

interface LeadForApply {
  id: string;
  company: string | null;
  title: string | null;
  apply_url: string | null;
  source_url: string | null;
  description_text: string | null;
  status: string;
  status_changed_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  application_id: string | null;
}

interface OwnerAppliedPayload {
  note: string | null;
  lead_id: string;
  sent_resume_id: string | null;
  /** When the action actually ran. The event's `ts` is the (possibly backdated)
   * applied_at — what the public card's "entered APPLIED" reads — so the undo
   * window is measured from this instead. Absent on rows written before it. */
  created_at?: string;
  prior: {
    status: string;
    status_changed_at: string | null;
    closed_at: string | null;
    closed_reason: string | null;
  };
}

/** A refusal raised inside the transaction (rolls it back) and turned into a response. */
class ApplyRefusal extends Error {
  constructor(readonly outcome: AdminWriteOutcome) {
    super('apply refused');
  }
}

function loadLeadForApply(db: Database.Database, leadId: string): LeadForApply | undefined {
  return db
    .prepare(
      `SELECT id, company, title, apply_url, source_url, description_text, status, status_changed_at,
              closed_at, closed_reason, application_id
         FROM job_leads WHERE id = ?`,
    )
    .get(leadId) as LeadForApply | undefined;
}

/** An open application with the same normalized company + title (the matcher's
 * normalization), or undefined. */
function findOpenDuplicate(
  db: Database.Database,
  company: string | null,
  title: string | null,
): { id: string; company_name: string; role_title: string; status: string } | undefined {
  const co = normCompany(company);
  const ti = normText(title);
  if (!co || !ti) return undefined;
  const rows = db.prepare('SELECT id, company_name, role_title, status FROM applications').all() as Array<{
    id: string;
    company_name: string;
    role_title: string;
    status: string;
  }>;
  return rows.find(
    (r) =>
      !CLOSED_APPLICATION_STATUSES.has(String(r.status ?? '').toUpperCase()) &&
      normCompany(r.company_name) === co &&
      normText(r.role_title) === ti,
  );
}

function isReadyResumeOfLead(db: Database.Database, resumeId: string, leadId: string): boolean {
  if (!hasTable(db, 'tailored_resumes')) return false;
  return !!db
    .prepare(`SELECT 1 FROM tailored_resumes WHERE id = ? AND lead_id = ? AND status = 'ready'`)
    .get(resumeId, leadId);
}

/** Every timezone's local calendar date is within one day of the UTC date (UTC−12
 * … UTC+14), so this bound is geometry, not a tunable. */
const MAX_LOCAL_DAY_OFFSET_FROM_UTC = 1;
const MS_PER_DAY = 86_400_000;

/**
 * The owner's LOCAL calendar date ('YYYY-MM-DD', what the page sends) → the
 * stored `applied_at`, or null when malformed / not a real date / in the future.
 * Measured in whole calendar days against the server's UTC date:
 *   - more than one day ahead → refused (no timezone is that far east);
 *   - the UTC date, or one day either side → `now` — for some timezone that local
 *     date IS today, so it is the instant the owner clicked;
 *   - two or more days back → a genuine backdate, stored at noon UTC so no
 *     timezone renders it as the previous day.
 */
function parseAppliedDate(raw: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null;
  const utcToday = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const dayOffset = Math.round((d.getTime() - utcToday.getTime()) / MS_PER_DAY);
  if (dayOffset > MAX_LOCAL_DAY_OFFSET_FROM_UTC) return null;
  if (dayOffset >= -MAX_LOCAL_DAY_OFFSET_FROM_UTC) return now.toISOString();
  return `${raw}T12:00:00.000Z`;
}

/**
 * `applied_from_lead {lead_id, applied_at?, note?, tailored_resume_id?,
 * confirm_duplicate?}` — in the fixed order §24.202 D8 states, because a SQLite
 * transaction cannot span the classification call:
 *   (1) classify the industry (falls back to 'misc');
 *   (2) ONE synchronous transaction: re-check the lead and the duplicate,
 *       allocate the label, insert the application at APPLIED (obfuscated),
 *       link the CLICKED lead by id, write the owner note event;
 *   (3) after commit: refresh the public pipeline row, run the status reactor
 *       (its lead promotion is a no-op — the link is made), score win-confidence.
 * Never throws: every failure is a structured response.
 */
export async function applyAppliedFromLead(
  db: Database.Database,
  raw: Record<string, unknown>,
  deps: AppliedFromLeadDeps = {},
): Promise<AdminWriteOutcome> {
  const classify = deps.classify ?? classifyJobIndustry;
  const score = deps.scoreWinConfidence ?? scoreWinConfidence;
  const clock = deps.now ?? (() => new Date());

  const leadId = typeof raw.lead_id === 'string' ? raw.lead_id : '';
  if (!leadId) return { status: 400, body: { error: 'lead_id (string) is required' } };
  if (raw.note != null && typeof raw.note !== 'string')
    return { status: 400, body: { error: 'note must be a string' } };
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
  const noteMax = ownerNoteMaxChars(db);
  if (note && note.length > noteMax) {
    return { status: 400, body: { error: `note exceeds ${noteMax} characters` } };
  }
  if (raw.tailored_resume_id != null && typeof raw.tailored_resume_id !== 'string') {
    return { status: 400, body: { error: 'tailored_resume_id must be a string' } };
  }
  const resumeId = typeof raw.tailored_resume_id === 'string' && raw.tailored_resume_id ? raw.tailored_resume_id : null;
  const confirmDuplicate = raw.confirm_duplicate === true;

  try {
    const startedAt = clock();
    let appliedAt = startedAt.toISOString();
    if (raw.applied_at != null) {
      const parsed = typeof raw.applied_at === 'string' ? parseAppliedDate(raw.applied_at, startedAt) : null;
      if (!parsed) return { status: 400, body: { error: 'applied_at must be a past or present YYYY-MM-DD date' } };
      appliedAt = parsed;
    }

    // Cheap pre-checks BEFORE any LLM spend; all re-checked inside the transaction.
    const lead = loadLeadForApply(db, leadId);
    if (!lead) return { status: 404, body: { error: `no job_lead with id "${leadId}"` } };
    if (lead.application_id) return { status: 409, body: { error: 'already_linked' } };
    if (resumeId && !isReadyResumeOfLead(db, resumeId, leadId)) {
      return { status: 400, body: { error: 'tailored_resume_id is not a ready résumé of this lead' } };
    }
    if (!lead.company?.trim() || !lead.title?.trim()) {
      return { status: 400, body: { error: 'lead has no company or title to create an application from' } };
    }
    const dupBefore = findOpenDuplicate(db, lead.company, lead.title);
    if (dupBefore && !confirmDuplicate) return { status: 409, body: { error: 'duplicate', duplicate_of: dupBefore } };

    // (1) Classification — outside the transaction (async). Best-effort.
    let industry = 'misc';
    if (lead.description_text && lead.description_text.trim()) {
      try {
        industry = (await classify(lead.description_text, lead.title)) || 'misc';
      } catch (err) {
        log.warn('applied_from_lead: classification failed — label stays misc', { leadId, err });
      }
    }

    // (2) One synchronous transaction.
    const now = clock().toISOString();
    const applicationId = generateId('app');
    const eventId = generateId('fe');
    let obfuscatedLabel = '';
    let priorStatus = '';
    db.transaction(() => {
      const fresh = loadLeadForApply(db, leadId);
      if (!fresh) throw new ApplyRefusal({ status: 404, body: { error: `no job_lead with id "${leadId}"` } });
      if (fresh.application_id) throw new ApplyRefusal({ status: 409, body: { error: 'already_linked' } });
      if (resumeId && !isReadyResumeOfLead(db, resumeId, leadId)) {
        throw new ApplyRefusal({
          status: 400,
          body: { error: 'tailored_resume_id is not a ready résumé of this lead' },
        });
      }
      const dup = findOpenDuplicate(db, fresh.company, fresh.title);
      if (dup && !confirmDuplicate) {
        throw new ApplyRefusal({ status: 409, body: { error: 'duplicate', duplicate_of: dup } });
      }
      priorStatus = fresh.status;

      obfuscatedLabel = insertApplicationCore(db, {
        id: applicationId,
        industry,
        now,
        company_name: fresh.company,
        role_title: fresh.title,
        public_state: 'obfuscated',
        job_url: fresh.apply_url || fresh.source_url || null,
        jd_text: fresh.description_text,
        status: 'APPLIED',
        applied_at: appliedAt,
        sent_resume_id: resumeId,
      }).obfuscated_label;

      // Link BY ID — the lead the owner clicked, even when archived or when a
      // higher-scored same-title lead exists (the matcher would pick that one).
      const linked = db
        .prepare(
          `UPDATE job_leads
              SET application_id = @appId, status = 'applied', status_changed_at = @now,
                  closed_at = NULL, closed_reason = NULL
            WHERE id = @id AND application_id IS NULL`,
        )
        .run({ id: leadId, appId: applicationId, now });
      if (linked.changes !== 1) throw new ApplyRefusal({ status: 409, body: { error: 'already_linked' } });

      const payload: OwnerAppliedPayload = {
        note,
        lead_id: leadId,
        sent_resume_id: resumeId,
        created_at: now,
        prior: {
          status: fresh.status,
          status_changed_at: fresh.status_changed_at,
          closed_at: fresh.closed_at,
          closed_reason: fresh.closed_reason,
        },
      };
      db.prepare(
        `INSERT INTO pipeline_events
           (id, application_id, kind, from_status, to_status, payload, source, proactive, ts)
         VALUES (@id, @application_id, @kind, NULL, 'APPLIED', @payload, @source, 0, @ts)`,
      ).run({
        id: eventId,
        application_id: applicationId,
        kind: OWNER_APPLIED_EVENT_KIND,
        payload: JSON.stringify(payload),
        source: OWNER_EVENT_SOURCE,
        // The application entered APPLIED when the owner applied, not when they
        // clicked — the public card's stage_entered_at derives from this ts.
        ts: appliedAt,
      });
    })();

    log.info('admin: application created from lead', {
      applicationId,
      leadId,
      obfuscated_label: obfuscatedLabel,
      duplicate_confirmed: !!(dupBefore && confirmDuplicate),
    });

    // (3) After commit. Deliberately NO mirrorPipelineEvent: the owner note is
    // private. Each step is best-effort and never fails the response.
    upsertPublicPipelineView(db, applicationId);
    reactToStatusTransitions(db, null, [{ application_id: applicationId, from: null, to: 'APPLIED' }]);
    void Promise.resolve()
      .then(() => score(db))
      .catch((scoreErr) => log.error('scoreWinConfidence after applied_from_lead failed', { scoreErr }));

    const windowS = Math.max(0, Number(getConfig<number>(db, 'applied_undo_window_s', 300)) || 0);
    return {
      status: 200,
      body: {
        ok: true,
        application_id: applicationId,
        obfuscated_label: obfuscatedLabel,
        lead_id: leadId,
        prior_status: priorStatus,
        undo_until: new Date(new Date(now).getTime() + windowS * 1000).toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof ApplyRefusal) return err.outcome;
    log.error('applied_from_lead failed', { leadId, err });
    return { status: 500, body: { error: 'applied_from_lead failed', detail: errMessage(err) } };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What else references an application, by table — anything here means the
 * pipeline has moved on and undo would destroy someone else's record. Excludes
 * only the rows "I applied" itself created (its owner event, its public view
 * row, the clicked lead).
 */
function otherApplicationReferences(
  db: Database.Database,
  app: { id: string; obfuscated_label: string | null },
  ownEventId: string,
  leadId: string,
): string[] {
  const refs: string[] = [];
  const count = (table: string, sql: string, ...params: unknown[]): void => {
    if (!hasTable(db, table)) return;
    const n = (db.prepare(sql).get(...params) as { n: number }).n;
    if (n > 0) refs.push(`${table} (${n})`);
  };
  count(
    'pipeline_events',
    'SELECT COUNT(*) AS n FROM pipeline_events WHERE application_id = ? AND id != ?',
    app.id,
    ownEventId,
  );
  count('email_events', 'SELECT COUNT(*) AS n FROM email_events WHERE linked_application_id = ?', app.id);
  count('interview_kits', 'SELECT COUNT(*) AS n FROM interview_kits WHERE application_id = ?', app.id);
  count('public_kit_view', 'SELECT COUNT(*) AS n FROM public_kit_view WHERE application_id = ?', app.id);
  count('learnings', 'SELECT COUNT(*) AS n FROM learnings WHERE application_id = ?', app.id);
  count('job_leads', 'SELECT COUNT(*) AS n FROM job_leads WHERE application_id = ? AND id != ?', app.id, leadId);
  count('attribution_link', 'SELECT COUNT(*) AS n FROM attribution_link WHERE application_id = ?', app.id);
  count(
    'public_audit_trail',
    `SELECT COUNT(*) AS n FROM public_audit_trail
      WHERE source_pipeline_event_id IN (SELECT id FROM pipeline_events WHERE application_id = @id)
         OR (@label != '' AND application_ref = @label)
         OR instr(COALESCE(details_json, ''), @id) > 0`,
    { id: app.id, label: app.obfuscated_label ?? '' },
  );
  return refs;
}

/** When the "I applied" action ran: the payload's `created_at`, falling back to
 * the event ts for a row written before the field existed (whose ts was the
 * creation time). */
function ownerEventCreatedAtMs(event: { ts: string; payload: string }): number {
  try {
    const created = (JSON.parse(event.payload) as Partial<OwnerAppliedPayload>).created_at;
    const ms = typeof created === 'string' ? new Date(created).getTime() : NaN;
    if (Number.isFinite(ms)) return ms;
  } catch {
    // unreadable payload — the caller reports it; fall back to the event ts
  }
  return new Date(event.ts).getTime();
}

/**
 * `undo_applied {application_id}` — reverse an "I applied" within
 * `applied_undo_window_s`. One transaction, FK-safe order: the owner event, the
 * public pipeline row, the lead link (prior status + closure restored, link
 * NULLed), then the application. Refused once anything else references the
 * application. A win-confidence write that lands after this is a no-op: the
 * scorer's UPDATE matches no row and the public-view refresh returns early for a
 * missing application. Never throws.
 */
export function applyUndoApplied(
  db: Database.Database,
  raw: Record<string, unknown>,
  deps: { now?: () => Date } = {},
): AdminWriteOutcome {
  const applicationId = typeof raw.application_id === 'string' ? raw.application_id : '';
  if (!applicationId) return { status: 400, body: { error: 'application_id (string) is required' } };
  const clock = deps.now ?? (() => new Date());
  try {
    const app = db
      .prepare('SELECT id, obfuscated_label, created_at FROM applications WHERE id = ?')
      .get(applicationId) as { id: string; obfuscated_label: string | null; created_at: string } | undefined;
    const event = app
      ? (db
          .prepare(
            `SELECT id, ts, payload FROM pipeline_events
              WHERE application_id = ? AND kind = ? AND source = ?
              ORDER BY ts ASC LIMIT 1`,
          )
          .get(applicationId, OWNER_APPLIED_EVENT_KIND, OWNER_EVENT_SOURCE) as
          | { id: string; ts: string; payload: string }
          | undefined)
      : undefined;
    if (!app || !event) {
      return { status: 404, body: { error: `no "I applied" application with id "${applicationId}"` } };
    }

    const windowS = Math.max(0, Number(getConfig<number>(db, 'applied_undo_window_s', 300)) || 0);
    // Measured from when the action ran (payload.created_at), never from the
    // event ts, which is the possibly-backdated applied_at.
    if (clock().getTime() > ownerEventCreatedAtMs(event) + windowS * 1000) {
      return { status: 409, body: { error: 'undo_window_passed' } };
    }

    let payload: OwnerAppliedPayload;
    try {
      payload = JSON.parse(event.payload) as OwnerAppliedPayload;
    } catch {
      return { status: 500, body: { error: 'owner event payload is unreadable' } };
    }
    const leadId = payload.lead_id;
    const prior = payload.prior;

    const outcome = db.transaction((): AdminWriteOutcome => {
      const refs = otherApplicationReferences(db, app, event.id, leadId);
      if (refs.length > 0) {
        return { status: 409, body: { error: 'referenced', detail: `referenced by ${refs.join(', ')}` } };
      }
      db.prepare('DELETE FROM pipeline_events WHERE id = ?').run(event.id);
      if (hasTable(db, 'public_pipeline_view')) {
        db.prepare('DELETE FROM public_pipeline_view WHERE application_id = ?').run(applicationId);
      }
      db.prepare(
        `UPDATE job_leads
            SET application_id = NULL, status = @status, status_changed_at = @status_changed_at,
                closed_at = @closed_at, closed_reason = @closed_reason
          WHERE id = @id AND application_id = @appId`,
      ).run({
        id: leadId,
        appId: applicationId,
        status: prior.status,
        status_changed_at: prior.status_changed_at ?? clock().toISOString(),
        closed_at: prior.closed_at,
        closed_reason: prior.closed_reason,
      });
      db.prepare('DELETE FROM applications WHERE id = ?').run(applicationId);
      return { status: 200, body: { ok: true, lead_id: leadId, restored_status: prior.status } };
    })();
    log.info('admin: undo_applied', { applicationId, leadId, status: outcome.status });
    return outcome;
  } catch (err) {
    log.error('undo_applied failed', { applicationId, err });
    return { status: 500, body: { error: 'undo_applied failed', detail: errMessage(err) } };
  }
}

// ── record_pipeline_event ────────────────────────────────────────────────────

export async function handleRecordPipelineEvent(
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
  warnUnknownStatus(to_status, 'handleRecordPipelineEvent');

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
      `INSERT INTO pipeline_events
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

    log.info('Pipeline event recorded', { event_id, application_id, kind });
    writeResponse(inDb, requestId, { ok: true, data: { event_id } });

    // Phase 4 §24.10 public mirror. Runs after writeResponse so mirror
    // latency never blocks the agent's MCP call. Errors are logged and
    // swallowed — the private write is committed regardless.
    try {
      await mirrorPipelineEvent(db, event_id);
    } catch (mirrorErr) {
      log.error('mirrorPipelineEvent threw despite internal try/catch', { event_id, mirrorErr });
    }

    // Refresh the public pipeline read-model (status / stage_entered_at /
    // last_activity_at changed). Best-effort; the function never throws.
    upsertPublicPipelineView(db, application_id);
  } catch (err) {
    log.error('handleRecordPipelineEvent failed', { application_id, err });
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
