/**
 * src/modules/portal/dev-inspector.ts — the dev-only inspector + sim-control
 * backend (Sub-milestone 24.42b).
 *
 * Backs the gated `/api/dev/*` endpoints: read the recruiter-sim's live state +
 * the candidate/persona that drives the agent, and light-control the dev-loop
 * pacing knobs. Two load-bearing guards (per §24.42):
 *
 *   1. `isDevEnv()` — every `/api/dev/*` route 404s unless `ENVIRONMENT==='dev'`.
 *      Evaluated at REQUEST time (not at boot) so it can't be cached on the wrong
 *      side of a deploy, and so the loop's live-toggle semantics hold. On a prod
 *      stack (a public surface) these endpoints simply do not exist — the
 *      candidate's real unredacted PII (`candidate_profile`/persona, served by
 *      `/api/dev/persona`) is never reachable there.
 *   2. The knob write allow-list — the write endpoint accepts ONLY keys in the
 *      canonical registry (`knob-registry.ts`) and validates each value's
 *      type/range. The dev inspector writes the WHOLE registry (incl. the
 *      recruiter-sim + dev_model_tier knobs the prod `/admin` surface denies);
 *      the registry is the single source of truth shared with `/admin` (§24.138).
 *
 * The builders are pure-ish (take a db handle + inputs, return plain data); the
 * HTTP shell in api.ts wraps them with its `json()` writer.
 */
import type Database from 'better-sqlite3';

import { DATA_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { applyFunnelFromEmailEvents } from '../career-pilot/funnel-apply.js';
import { findOpsSession } from '../career-pilot/ops-session.js';
import { scoreWinConfidence } from '../career-pilot/win-confidence.js';
import { type CandidateProfile, readCandidateProfile, renderPersona } from '../career-pilot/render-persona.js';
import { reconcileState } from '../career-pilot/recruiter-sim/runner.js';
import { STAGE_CLASSIFICATIONS } from '../career-pilot/recruiter-sim/templates.js';
import type { SimApp, SimState } from '../career-pilot/recruiter-sim/types.js';
import { FUNNEL_DATA_TABLES, SESSION_TABLES, clearSessionTranscripts, wipeTables } from './dev/app-data-reset.js';
import { executeControlCommand } from './kill-switch.js';
import { ALL_KNOB_KEYS, buildKnobs, writePreference, type KnobView } from './knob-registry.js';
import { getPauseState, type PauseState } from './system-modes.js';

/** The hard environment gate. Read at request time — see the module header. */
export function isDevEnv(): boolean {
  return process.env.ENVIRONMENT === 'dev';
}

// ── the knob write surface (the dev inspector writes the WHOLE registry) ───────
// The registry (types + specs + validation + the write/read helpers) lives in
// knob-registry.ts so the prod /admin control-center can share it (§24.138).
// Re-exported here so the dev inspector's existing public API is unchanged.
export { applyKnobWrite, validateKnobWrite, type KnobSpec } from './knob-registry.js';

/** The dev inspector's write allow-list = every key in the canonical registry. */
export const DEV_INSPECTOR_WRITABLE_KEYS = ALL_KNOB_KEYS;

/** Current value + metadata for every writable knob (drives the dev control UI). */
export function buildDevKnobs(db: Database.Database): { knobs: KnobView[] } {
  return { knobs: buildKnobs(db, ALL_KNOB_KEYS) };
}

interface SimApplicationRow {
  id: string;
  company_name: string | null;
  obfuscated_label: string | null;
  role_title: string | null;
  status: string;
  applied_at: string | null;
  last_activity_at: string | null;
}

/** Each sim app + the NEXT email it has queued (so the page shows what's coming). */
export type SimAppView = SimApp & {
  /** Total funnel stages before the terminal email (for an "i/N" progress read). */
  totalStages: number;
  /** The classification of the next email this app will inject — or its end state. */
  upcoming: string;
};

/**
 * What the sim has coming next for one app: the classification at `stageIndex`,
 * the terminal decision once past the linear stages, or its end state when the
 * thread ghosted / closed. Mirrors `scenario.stepApp` (authoritative — driven by
 * the same `STAGE_CLASSIFICATIONS`).
 */
export function simUpcoming(app: SimApp): string {
  if (app.status === 'ghosted') return 'ghosted — no further mail';
  if (app.status === 'closed') return app.outcome ? `closed · ${app.outcome}` : 'closed';
  if (app.stageIndex >= STAGE_CLASSIFICATIONS.length) return 'final decision · offer/rejection';
  return STAGE_CLASSIFICATIONS[app.stageIndex];
}

/**
 * The sim's live scenario state (from the sidecar) joined to the `applications`
 * rows it seeded — so the page can show both the sim's internal funnel walk
 * (incl. what's queued next) and the real funnel position the curator advanced
 * the rows to.
 */
export function buildDevState(
  db: Database.Database,
  state: SimState,
): {
  enabled: boolean;
  lastSeedAtMs: number;
  apps: SimAppView[];
  applications: SimApplicationRow[];
  /** System pause state (§24.43e) — `halted` means LLM spend is frozen. */
  pauseState: PauseState;
} {
  const enabled = getConfig<boolean>(db, 'recruiter_sim_enabled');
  // Drop sidecar apps whose `applications` row is gone (e.g. just after an
  // /api/dev/reset funnel-data/everything wipe, §24.48) so the panel shows the
  // sim's real working set — the same reconcile `runOneTick` applies before it
  // acts, so the display matches behavior instead of showing ghost rows until the
  // next tick re-saves the sidecar.
  const live = reconcileState(db, state);
  const ids = live.apps.map((a) => a.appId);
  let applications: SimApplicationRow[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    applications = db
      .prepare(
        `SELECT id, company_name, obfuscated_label, role_title, status, applied_at, last_activity_at
           FROM applications WHERE id IN (${placeholders})`,
      )
      .all(...ids) as SimApplicationRow[];
  }
  const apps: SimAppView[] = live.apps.map((a) => ({
    ...a,
    totalStages: STAGE_CLASSIFICATIONS.length,
    upcoming: simUpcoming(a),
  }));
  return { enabled, lastSeedAtMs: live.lastSeedAtMs, apps, applications, pauseState: getPauseState() };
}

// ── dev "Pause LLM spend" control (§24.43e) ──────────────────────────────────

export interface DevControlOutcome {
  status: number;
  body: unknown;
}

/**
 * The dev "Pause LLM spend" control. Freezes ALL LLM spend while leaving the GCP
 * infra up — for stepping away without burning credits.
 *
 *  - `pause`  → `executeControlCommand('/halt')`: `pause_state='halted'`, which
 *    the container-runner spawn gate enforces (no container spawns at all —
 *    reactive OR proactive — so the agent cannot make an LLM call) + kills any
 *    running containers. ALSO flips `recruiter_sim_enabled=false`, because the
 *    sim is host-side and doesn't honor `pause_state` (its Haiku enrichment would
 *    keep spending otherwise).
 *  - `resume` → `executeControlCommand('/resume')`: back to `pause_state='active'`.
 *    Leaves the sim off — it's re-enabled deliberately via its own toggle.
 *
 * `/killswitch` is intentionally NOT reachable here — only the reversible states.
 * Reuses the built control plane (kill-switch.ts), so the effect is identical to
 * the Telegram `/halt` + `/resume`.
 */
export function applyDevControl(db: Database.Database, raw: unknown): DevControlOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { action: "pause" | "resume" }' } };
  }
  const action = (raw as { action?: unknown }).action;

  if (action === 'pause') {
    const outcome = executeControlCommand('/halt', 'dev: pause LLM spend', 'dev-inspector');
    writePreference(db, 'recruiter_sim_enabled', 'false');
    return { status: 200, body: { pauseState: outcome.state, killed: outcome.killed, simEnabled: false } };
  }

  if (action === 'resume') {
    const outcome = executeControlCommand('/resume', null, 'dev-inspector');
    return {
      status: 200,
      body: { pauseState: outcome.state, simEnabled: getConfig<boolean>(db, 'recruiter_sim_enabled') },
    };
  }

  return { status: 400, body: { error: `unknown action: ${String(action)} (expected "pause" | "resume")` } };
}

// ── dev reset controls (§24.48) ──────────────────────────────────────────────

export type DevResetScope = 'funnel-data' | 'conversation' | 'profile' | 'everything';

const RESET_SCOPES: DevResetScope[] = ['funnel-data', 'conversation', 'profile', 'everything'];

export interface DevResetOutcome {
  status: number;
  body: unknown;
}

/**
 * DELETE the single candidate_profile row. Safe: `update_profile_field` re-creates
 * id=1 on the next onboarding write (`INSERT … VALUES (1, …) ON CONFLICT DO NOTHING`
 * then UPDATE — see career-pilot/actions.ts), so the agent re-onboards cleanly.
 */
function deleteCandidateProfile(db: Database.Database): number {
  try {
    return db.prepare('DELETE FROM candidate_profile').run().changes;
  } catch {
    return 0; // table only exists after migration 105
  }
}

/** NULL one onboarding field on the single-row candidate_profile (per-field re-test). */
function nullProfileField(db: Database.Database, field: string): number {
  try {
    return db
      .prepare(`UPDATE candidate_profile SET ${field} = NULL, updated_at = ? WHERE id = 1`)
      .run(new Date().toISOString()).changes;
  } catch {
    return 0;
  }
}

/**
 * The dev "Reset" control (§24.48). Takes EXACTLY ONE of `{ scope }` / `{ field }`:
 *
 *   scope: 'funnel-data'  → clear the funnel/app tables (keeps profile + chat). No halt.
 *   scope: 'conversation' → halt + kill container, clear `sessions` + transcripts,
 *                           sim off. Leaves halted (the crons re-bootstrap next session).
 *   scope: 'profile'      → DELETE candidate_profile → onboarding restarts. No halt.
 *   scope: 'everything'   → funnel-data + profile + conversation (true pre-bootstrap). Halts.
 *   field: <onboarding>   → NULL that one profile field (re-test one onboarding step). No halt.
 *
 * Session-clearing scopes HALT FIRST so no container is mid-write when its session
 * + inbound DB vanish (§24.48). 400 on any invalid/ambiguous input — nothing is
 * written in that case. Dev-gated upstream by `isDevEnv()` in api.ts.
 */
export function applyDevReset(db: Database.Database, raw: unknown): DevResetOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { scope } or { field }' } };
  }
  const body = raw as { scope?: unknown; field?: unknown };
  const hasScope = typeof body.scope === 'string';
  const hasField = typeof body.field === 'string';
  if (hasScope === hasField) {
    return { status: 400, body: { error: 'provide exactly one of "scope" or "field"' } };
  }

  // Per-field profile reset (no halt — must not freeze the agent to re-test one step).
  if (hasField) {
    const field = body.field as string;
    if (!(ONBOARDING_FIELD_ORDER as readonly string[]).includes(field)) {
      return { status: 400, body: { error: `field not resettable: ${field}` } };
    }
    return { status: 200, body: { field, cleared: { [field]: nullProfileField(db, field) }, halted: false } };
  }

  // Scoped reset.
  const scope = body.scope as string;
  if (!RESET_SCOPES.includes(scope as DevResetScope)) {
    return { status: 400, body: { error: `unknown scope: ${scope}` } };
  }
  const s = scope as DevResetScope;
  const clearsSessions = s === 'conversation' || s === 'everything';

  // Halt BEFORE any wipe for session-clearing scopes — kills any running container
  // so nothing is mid-write when its session + inbound DB vanish — and turn the sim
  // off (it's host-side, ignores pause_state, and would keep re-seeding the board we
  // just cleared). Mirrors applyDevControl's pause.
  let halted = false;
  if (clearsSessions) {
    executeControlCommand('/halt', `dev: reset (${s})`, 'dev-inspector');
    writePreference(db, 'recruiter_sim_enabled', 'false');
    halted = true;
  }

  const tables: string[] = [];
  if (s === 'funnel-data' || s === 'everything') tables.push(...FUNNEL_DATA_TABLES);
  if (clearsSessions) tables.push(...SESSION_TABLES);

  const cleared: Record<string, number> = tables.length > 0 ? wipeTables(db, tables) : {};
  if (clearsSessions) cleared.transcripts = clearSessionTranscripts(DATA_DIR);
  if (s === 'profile' || s === 'everything') cleared.candidate_profile = deleteCandidateProfile(db);

  return { status: 200, body: { scope: s, cleared, halted } };
}

// ── on-demand pipeline-scribe sweep (§24.43c) ────────────────────────────────

const SWEEP_PROMPT = '[scheduled trigger: pipeline-scribe]';

export interface DevSweepOutcome {
  status: number;
  body: unknown;
}

/**
 * Insert a ONE-SHOT pipeline-scribe trigger row into an inbound DB: the same
 * sentinel the daily cron fires, but `recurrence=NULL` + `process_after=now` so
 * it runs once, immediately. `series_id` is the row's own id (a one-shot series,
 * so it never collides with the recurring `funnel-curator` series or its clone
 * logic). Takes the inbound DB → unit-testable. Returns the row id.
 */
export function enqueueSweepTask(inDb: Database.Database): string {
  const id = `sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (@id, @seq, datetime('now'), 'pending', 0, datetime('now'), NULL, 'task', NULL, NULL, NULL, @content, @id)`,
    )
    .run({ id, seq: nextEvenSeq(inDb), content: JSON.stringify({ prompt: SWEEP_PROMPT, script: null }) });
  return id;
}

/**
 * The dev "Sweep & convert now" action (§24.43c). Two parts:
 *   1. CONVERT (immediate, deterministic, host-side) — `applyFunnelFromEmailEvents`
 *      converges the funnel board from the mail the curator has ALREADY classified
 *      into `email_events`, without waiting for (or re-fetching) anything. This is
 *      what makes already-consumed mail (the cursor has moved past it) show up.
 *   2. SWEEP (async, best-effort) — enqueue a fresh `[scheduled trigger:
 *      pipeline-scribe]` task so the orchestrator fetches any NEW mail; that run's
 *      persist auto-converts via the same path (funnel-actions hook). Targets the
 *      OPS session (§24.67 — where the pipeline-scribe series lives; the previous
 *      findSessionByAgentGroup picked the *newest* active session, which post-split
 *      is the wrong one). Skipped (no error) when the ops session doesn't exist
 *      yet, or while halted/paused.
 */
export async function applyDevSweep(): Promise<DevSweepOutcome> {
  const db = getDb();
  const applied = applyFunnelFromEmailEvents(db);
  // Score win_confidence with intelligence AFTER the convert (it reads the
  // just-applied stages). Best-effort + Portkey-gated — never throws.
  const wc = await scoreWinConfidence(db);

  let sweepEnqueued = false;
  const group = getAgentGroupByFolder('career-pilot');
  const session = group ? findOpsSession(group.id) : undefined;
  if (group && session) {
    const inDb = openInboundDb(group.id, session.id);
    try {
      enqueueSweepTask(inDb);
      sweepEnqueued = true;
    } finally {
      inDb.close();
    }
  }

  log.info('dev: sweep & convert', { converted: applied.converted, scored: wc.scored, sweepEnqueued });
  return {
    status: 200,
    body: { converted: applied.converted, changes: applied.changes, scored: wc.scored, sweepEnqueued },
  };
}

// ── persona / onboarding ──────────────────────────────────────────────────────

/** The onboarding interview order (one field per turn) — mirrors render-persona's sentinel. */
export const ONBOARDING_FIELD_ORDER = [
  'full_name',
  'target_roles',
  'comp_floor',
  'location_pref',
  'master_resume',
  'bio',
  'search_goals',
] as const;

function jsonArrayNonEmpty(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** A populated location preference: a non-empty JSON object (not null / `{}` / array). */
function jsonObjectNonEmpty(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function fieldFilled(profile: CandidateProfile, field: string): boolean {
  switch (field) {
    case 'target_roles':
      return jsonArrayNonEmpty(profile.target_roles);
    case 'location_pref':
      return jsonObjectNonEmpty(profile.location_pref);
    case 'comp_floor':
      return profile.comp_floor != null;
    default:
      return !!(profile as unknown as Record<string, unknown>)[field];
  }
}

export interface OnboardingProgress {
  fields: Array<{ field: string; filled: boolean }>;
  filledCount: number;
  totalCount: number;
  complete: boolean;
  nextField: string | null;
}

/** Which onboarding fields are populated, in interview order. */
export function computeOnboardingProgress(profile: CandidateProfile | null): OnboardingProgress {
  const fields = ONBOARDING_FIELD_ORDER.map((field) => ({
    field,
    filled: profile ? fieldFilled(profile, field) : false,
  }));
  const filledCount = fields.filter((f) => f.filled).length;
  const next = fields.find((f) => !f.filled);
  return {
    fields,
    filledCount,
    totalCount: fields.length,
    complete: filledCount === fields.length,
    nextField: next ? next.field : null,
  };
}

/**
 * The candidate/persona panel: the raw `candidate_profile` row (real PII — the
 * reason this whole surface is dev-only + owner-only), the freshly-rendered
 * `candidate.md` (what the next spawn will compose; the onboarding sentinel when
 * the profile is empty), and the onboarding progress.
 */
export function buildDevPersona(profile: CandidateProfile | null): {
  profile: CandidateProfile | null;
  candidateMd: string;
  onboarding: OnboardingProgress;
} {
  return {
    profile,
    candidateMd: renderPersona(profile),
    onboarding: computeOnboardingProgress(profile),
  };
}

/** Thin DB-bound wrapper used by the HTTP handler (reads the single profile row). */
export function buildDevPersonaFromDb(): ReturnType<typeof buildDevPersona> {
  return buildDevPersona(readCandidateProfile());
}
