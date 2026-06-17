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
 *   2. `DEV_INSPECTOR_WRITABLE_KEYS` — the write endpoint accepts ONLY this
 *      curated allow-list (the `recruiter_sim_*` knobs + the dev-loop pacing
 *      keys) and validates each value's type/range. No destructive ops, no
 *      arbitrary config — those stay on CI/Telegram per the standing
 *      "destructive ops off web buttons" lean.
 *
 * The builders are pure-ish (take a db handle + inputs, return plain data); the
 * HTTP shell in api.ts wraps them with its `json()` writer.
 */
import type Database from 'better-sqlite3';

import { DATA_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { getConfig, getConfigDefault } from '../../get-config.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { applyFunnelFromEmailEvents } from '../career-pilot/funnel-apply.js';
import { findOpsSession } from '../career-pilot/ops-session.js';
import { scoreWinConfidence } from '../career-pilot/win-confidence.js';
import { type CandidateProfile, readCandidateProfile, renderPersona } from '../career-pilot/render-persona.js';
import { SIM_KNOB_KEYS } from '../career-pilot/recruiter-sim/knobs.js';
import { reconcileState } from '../career-pilot/recruiter-sim/runner.js';
import { STAGE_CLASSIFICATIONS } from '../career-pilot/recruiter-sim/templates.js';
import type { SimApp, SimState } from '../career-pilot/recruiter-sim/types.js';
import { FUNNEL_DATA_TABLES, SESSION_TABLES, clearSessionTranscripts, wipeTables } from './dev/app-data-reset.js';
import { executeControlCommand } from './kill-switch.js';
import { getPauseState, type PauseState } from './system-modes.js';

/** The hard environment gate. Read at request time — see the module header. */
export function isDevEnv(): boolean {
  return process.env.ENVIRONMENT === 'dev';
}

// ── the write allow-list + per-knob validation specs ─────────────────────────

export type KnobType = 'boolean' | 'number' | 'cron' | 'enum';
export type KnobGroup = 'sim' | 'pacing' | 'budget' | 'polling' | 'models' | 'sessions' | 'telemetry';

export interface KnobSpec {
  type: KnobType;
  group: KnobGroup;
  label: string;
  /** Numeric bounds (inclusive), for `type: 'number'`. */
  min?: number;
  max?: number;
  integer?: boolean;
  /** Allowed values, for `type: 'enum'`. */
  options?: string[];
  /** Surfaced to the UI — e.g. cron changes only take effect on the next reclone. */
  note?: string;
}

const CRON_NOTE =
  'Saved immediately, but the running recurring task keeps its old cadence until its series is re-bootstrapped (next fresh session / reset:dev) — the bootstrap skips an existing task and the cron is copied onto the queued row at insert.';

const MODEL_TIER_NOTE =
  'Retargets the orchestrator + every subagent model for cost (dev only). Applies on the next container spawn (a fresh session / reset:dev), not mid-session. default = real Opus · sonnet = Opus→Sonnet (Haiku kept) · haiku = everything→Haiku.';

const OPS_SPAWN_NOTE =
  'Pushed as container env when the career-pilot ops session spawns — applies on its NEXT spawn, not mid-session. Other sessions keep the upstream rotation defaults.';

const OUTCOME_SPLIT_NOTE =
  'At an application’s terminal step the outcome is offer-vs-rejection in proportion to these two — only the RATIO matters (offer / (offer + rejection)), not the absolute values. Most apps never reach the terminal step (the screen-pass cull + ghosting close them earlier).';

// gmail_poll_interval_sec / calendar_poll_interval_sec are defined in
// defaults.json and exposed here, but nothing in src/ or the container reads
// them — inbound mail is pulled by the pipeline-scribe cron + the on-demand
// sweep, not a fixed poll loop. The notes say so honestly (§24.105).
const ORPHAN_POLL_NOTE =
  'No live consumer today — inbound mail is pulled by the pipeline-scribe cron (funnel_curator_cron) + the on-demand sweep, not a fixed poll loop. Kept as a tunable for a future host poller; changing it currently has no effect.';

/**
 * The curated knob set the dev inspector may write. The `recruiter_sim_*` keys
 * (the sim's own dial) plus the dev-loop pacing keys the owner asked to expose
 * so the whole proactive loop can be sped up for a watchable dev session. Every
 * entry is a `preferences`-tier key whose default lives in config/defaults.json.
 */
export const KNOB_SPECS: Record<string, KnobSpec> = {
  // ── the recruiter-sim dial (SIM_KNOB_KEYS) ──
  recruiter_sim_enabled: {
    type: 'boolean',
    group: 'sim',
    label: 'Sim enabled',
    note: 'Master toggle for the recruiter-sim host loop (seeding + stepping applications). Off → the sim does nothing. Also flipped off automatically by /halt and any session-clearing reset.',
  },
  recruiter_sim_job_source: {
    type: 'enum',
    group: 'sim',
    label: 'Job source',
    options: ['real', 'synthetic'],
    note: 'real → seed simulated applications from the scraped job_leads pool (real company/role/JD; falls back to synthetic when the pool is empty); synthetic → fictional companies.',
  },
  recruiter_sim_pace: {
    type: 'enum',
    group: 'sim',
    label: 'Pace',
    options: ['fast', 'realistic'],
    note: 'fast → minutes (compressed; email dates backdated); realistic → real-life timing (days between steps, real-time dates) so the funnel unfolds day-to-day.',
  },
  recruiter_sim_max_concurrent: {
    type: 'number',
    group: 'sim',
    label: 'Max concurrent',
    min: 0,
    max: 100,
    integer: true,
    note: 'Ceiling on simultaneously-active sim applications. A new application seeds only while the active count is below this; apps that close or ghost free a slot.',
  },
  recruiter_sim_screen_pass_rate: {
    type: 'number',
    group: 'sim',
    label: 'Screen pass rate',
    min: 0,
    max: 1,
    note: 'Fraction of applications that advance past the confirmation to a screen; the rest get an early rejection.',
  },
  recruiter_sim_offer_probability: {
    type: 'number',
    group: 'sim',
    label: 'Offer probability',
    min: 0,
    max: 1,
    note: OUTCOME_SPLIT_NOTE,
  },
  recruiter_sim_rejection_probability: {
    type: 'number',
    group: 'sim',
    label: 'Rejection probability',
    min: 0,
    max: 1,
    note: OUTCOME_SPLIT_NOTE,
  },
  recruiter_sim_ghost_probability: {
    type: 'number',
    group: 'sim',
    label: 'Ghost probability',
    min: 0,
    max: 1,
    note: 'Per-step chance (never on the very first email) that a thread goes quiet instead of advancing — leaves the application hanging to exercise close-detection.',
  },
  recruiter_sim_noise_ratio: {
    type: 'number',
    group: 'sim',
    label: 'Noise ratio',
    min: 0,
    max: 1,
    note: 'Per-tick chance of injecting a standalone non-application email (newsletter/digest) — classifier-precision filler the curator should classify as noise.',
  },
  recruiter_sim_daily_budget_usd: {
    type: 'number',
    group: 'sim',
    label: 'Sim daily budget (USD)',
    min: 0,
    max: 100,
    note: 'Caps the sim’s OWN host-side LLM spend (the Haiku that writes realistic email prose). Once spent, injected emails fall back to their deterministic templates. Separate from the owner/sandbox agent budgets.',
  },
  // ── dev-loop pacing (crons) ──
  funnel_curator_cron: { type: 'cron', group: 'pacing', label: 'Funnel curator cron', note: CRON_NOTE },
  funnel_curator_skip_classified_messages: {
    type: 'boolean',
    group: 'pacing',
    label: 'Curator skips classified mail',
    note: 'On (default): query_gmail_delta drops emails already classified on a prior run (present in email_events) before sending them to pipeline-scribe, so a full-sync does not re-process old noise every run. Off: a one-time full re-classification pass.',
  },
  close_detection_cron: { type: 'cron', group: 'pacing', label: 'Close detection cron', note: CRON_NOTE },
  killer_match_cron: { type: 'cron', group: 'pacing', label: 'Killer-match cron', note: CRON_NOTE },
  daily_briefing_time: { type: 'cron', group: 'pacing', label: 'Daily briefing cron', note: CRON_NOTE },
  job_scrape_cron: { type: 'cron', group: 'pacing', label: 'Job-scrape cron', note: CRON_NOTE },
  // ── dev cost caps ──
  owner_daily_llm_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Owner daily LLM budget (USD)',
    min: 0,
    max: 1000,
    note: 'A SOFT/advisory cap on the owner session’s daily LLM spend — the persona warns past ~80%, but the agent can still run past it. The hard stop is /killswitch (pause + kill containers).',
  },
  sandbox_daily_global_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Sandbox daily budget (USD)',
    min: 0,
    max: 1000,
    note: 'The HARD global cap on public-simulator (sandbox) spend — checkSimulatorAllowed refuses new runs once the day’s sandbox spend reaches it. Also the /architecture Web-sandbox "degraded" threshold.',
  },
  // ── poll intervals ──
  gmail_poll_interval_sec: {
    type: 'number',
    group: 'polling',
    label: 'Gmail poll interval (s)',
    min: 10,
    max: 86_400,
    note: `Intended cadence for polling the connected Gmail account. ${ORPHAN_POLL_NOTE}`,
  },
  calendar_poll_interval_sec: {
    type: 'number',
    group: 'polling',
    label: 'Calendar poll interval (s)',
    min: 10,
    max: 86_400,
    note: `Intended cadence for polling the connected Google Calendar. ${ORPHAN_POLL_NOTE}`,
  },
  // ── ops-session topology (§24.67) ──
  ops_transcript_rotate_bytes: {
    type: 'number',
    group: 'sessions',
    label: 'Ops transcript rotation (bytes)',
    min: 65_536,
    max: 12_582_912,
    integer: true,
    note: OPS_SPAWN_NOTE,
  },
  ops_transcript_rotate_age_days: {
    type: 'number',
    group: 'sessions',
    label: 'Ops transcript rotation (days)',
    min: 0,
    max: 14,
    note: `${OPS_SPAWN_NOTE} 0 disables the age check; size alone governs.`,
  },
  ops_mirror_to_chat: {
    type: 'boolean',
    group: 'sessions',
    label: 'Mirror ops output to chat',
    note: 'Owner-visible ops-session output (daily briefing, killer-match pings) is copied into the chat session as silent context so replies have their referent. Applies to the next delivery.',
  },
  container_idle_timeout_sec: {
    type: 'number',
    group: 'sessions',
    label: 'Idle container ceiling (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'How long a warm-but-idle container lives before the host sweep reaps it (default 1800 = 30 min). Idle = local polling only, no LLM spend — the cost is held RAM + one concurrency slot. Lower frees slots/RAM sooner; higher keeps containers warmer (no cold-start on a quick follow-up). Applies live on the next sweep tick.',
  },
  // ── observability (§24.68) ──
  telemetry_capture: {
    type: 'boolean',
    group: 'telemetry',
    label: 'Telemetry capture',
    note: 'Kill switch for BOTH the public per-turn rows (/live panels) and the private request_telemetry table. Applies to the next request.',
  },
  request_telemetry_retention_days: {
    type: 'number',
    group: 'telemetry',
    label: 'Request-telemetry retention (days)',
    min: 1,
    max: 365,
    integer: true,
    note: 'Rows older than this are pruned by the host-sweep maintenance step.',
  },
  health_check_interval_sec: {
    type: 'number',
    group: 'telemetry',
    label: 'Health-check interval (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'Cadence of the proactive host-side health run (new critical findings alert the owner Telegram once until cleared).',
  },
  health_failure_streak_threshold: {
    type: 'number',
    group: 'telemetry',
    label: 'Failure-streak threshold',
    min: 1,
    max: 50,
    integer: true,
    note: 'A provider whose newest N requests ALL failed raises a critical finding.',
  },
  // ── dev model tier (§24.43) ──
  dev_model_tier: {
    type: 'enum',
    group: 'models',
    label: 'Dev model tier',
    options: ['default', 'sonnet', 'haiku'],
    note: MODEL_TIER_NOTE,
  },
};

export const DEV_INSPECTOR_WRITABLE_KEYS = Object.keys(KNOB_SPECS);

// Compile-time-ish guarantee: every sim knob is writable from the inspector.
// (A unit test asserts the SIM_KNOB_KEYS ⊆ DEV_INSPECTOR_WRITABLE_KEYS containment.)
void SIM_KNOB_KEYS;

// ── value validation (pure) ──────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** The string to persist in the preferences tier (which stores everything as text). */
  stored?: string;
  /** The coerced native value (echoed back to the caller). */
  value?: boolean | number | string;
  error?: string;
}

/** Structural cron check: 5 whitespace-separated fields of the allowed charset. */
function isValidCron(v: string): boolean {
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[0-9*/,-]+$/.test(p));
}

/**
 * Validate (and coerce) a single knob write against its spec. Rejects unknown
 * keys (not on the allow-list) and out-of-type/out-of-range values. Pure.
 */
export function validateKnobWrite(key: string, value: unknown): ValidationResult {
  const spec = KNOB_SPECS[key];
  if (!spec) return { ok: false, error: `key not writable: ${key}` };

  if (spec.type === 'boolean') {
    let b: boolean;
    if (typeof value === 'boolean') b = value;
    else if (value === 'true' || value === '1') b = true;
    else if (value === 'false' || value === '0') b = false;
    else return { ok: false, error: `expected a boolean for ${key}` };
    return { ok: true, stored: b ? 'true' : 'false', value: b };
  }

  if (spec.type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `expected a number for ${key}` };
    if (spec.integer && !Number.isInteger(n)) return { ok: false, error: `${key} must be an integer` };
    if (spec.min != null && n < spec.min) return { ok: false, error: `${key} must be ≥ ${spec.min}` };
    if (spec.max != null && n > spec.max) return { ok: false, error: `${key} must be ≤ ${spec.max}` };
    return { ok: true, stored: String(n), value: n };
  }

  if (spec.type === 'enum') {
    const opts = spec.options ?? [];
    if (typeof value !== 'string' || !opts.includes(value)) {
      return { ok: false, error: `${key} must be one of: ${opts.join(', ')}` };
    }
    return { ok: true, stored: value, value };
  }

  // cron
  if (typeof value !== 'string' || !isValidCron(value)) {
    return { ok: false, error: `${key} must be a 5-field cron expression` };
  }
  return { ok: true, stored: value.trim(), value: value.trim() };
}

// ── preferences write ────────────────────────────────────────────────────────

function writePreference(db: Database.Database, key: string, stored: string): void {
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, stored, new Date().toISOString());
}

/** Whether a key carries a `preferences`-tier override (the thing "reset" clears). */
function hasPreference(db: Database.Database, key: string): boolean {
  try {
    return db.prepare('SELECT 1 FROM preferences WHERE key = ?').get(key) !== undefined;
  } catch {
    return false;
  }
}

/** Delete one key's override → its value falls back through the tiers to defaults.json. */
function deletePreference(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
}

/** Clear every writable knob's override at once. Returns the rows removed. */
function resetAllPreferences(db: Database.Database): number {
  const placeholders = DEV_INSPECTOR_WRITABLE_KEYS.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM preferences WHERE key IN (${placeholders})`).run(...DEV_INSPECTOR_WRITABLE_KEYS);
  return info.changes;
}

export interface KnobWriteOutcome {
  status: number;
  body: unknown;
}

/**
 * Mutate a knob. Three shapes (all allow-list-guarded):
 *   { key, value }       → validate + persist the override; echo the coerced value.
 *   { key, reset: true } → delete the override so it falls back to the default;
 *                          echo the now-effective (default) value.
 *   { resetAll: true }   → clear every writable knob's override at once.
 * 400 on any invalid/unknown input — nothing is written in that case.
 */
export function applyKnobWrite(db: Database.Database, raw: unknown): KnobWriteOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { key, value }' } };
  }
  const body = raw as { key?: unknown; value?: unknown; reset?: unknown; resetAll?: unknown };

  if (body.resetAll === true) {
    const cleared = resetAllPreferences(db);
    return { status: 200, body: { resetAll: true, cleared } };
  }

  if (typeof body.key !== 'string') {
    return { status: 400, body: { error: 'missing or non-string "key"' } };
  }
  const key = body.key;

  if (body.reset === true) {
    if (!KNOB_SPECS[key]) return { status: 400, body: { error: `key not writable: ${key}` } };
    deletePreference(db, key);
    return { status: 200, body: { key, reset: true, value: getConfig(db, key) } };
  }

  const res = validateKnobWrite(key, body.value);
  if (!res.ok) {
    return { status: 400, body: { error: res.error } };
  }
  writePreference(db, key, res.stored as string);
  const spec = KNOB_SPECS[key];
  return { status: 200, body: { key, value: res.value, applied: true, note: spec.note ?? null } };
}

// ── read builders ─────────────────────────────────────────────────────────────

export interface KnobView {
  key: string;
  value: unknown;
  /** The config/defaults.json value — what "reset" falls back to. */
  default: unknown;
  /** True when a preferences-tier override exists (so reset has something to clear). */
  overridden: boolean;
  type: KnobType;
  group: KnobGroup;
  label: string;
  min: number | null;
  max: number | null;
  integer: boolean;
  /** Allowed values for an `enum` knob (drives the select); null otherwise. */
  options: string[] | null;
  note: string | null;
}

/** Current value + metadata for every writable knob (drives the control UI). */
export function buildDevKnobs(db: Database.Database): { knobs: KnobView[] } {
  const knobs = DEV_INSPECTOR_WRITABLE_KEYS.map<KnobView>((key) => {
    const spec = KNOB_SPECS[key];
    return {
      key,
      value: getConfig(db, key),
      default: getConfigDefault(key),
      overridden: hasPreference(db, key),
      type: spec.type,
      group: spec.group,
      label: spec.label,
      min: spec.min ?? null,
      max: spec.max ?? null,
      integer: spec.integer ?? false,
      options: spec.options ?? null,
      note: spec.note ?? null,
    };
  });
  return { knobs };
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
