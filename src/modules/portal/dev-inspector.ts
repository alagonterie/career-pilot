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

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { getConfig, getConfigDefault } from '../../get-config.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { applyFunnelFromEmailEvents } from '../career-pilot/funnel-apply.js';
import { scoreWinConfidence } from '../career-pilot/win-confidence.js';
import { type CandidateProfile, readCandidateProfile, renderPersona } from '../career-pilot/render-persona.js';
import { SIM_KNOB_KEYS } from '../career-pilot/recruiter-sim/knobs.js';
import { STAGE_CLASSIFICATIONS } from '../career-pilot/recruiter-sim/templates.js';
import type { SimApp, SimState } from '../career-pilot/recruiter-sim/types.js';
import { executeControlCommand } from './kill-switch.js';
import { getPauseState, type PauseState } from './system-modes.js';

/** The hard environment gate. Read at request time — see the module header. */
export function isDevEnv(): boolean {
  return process.env.ENVIRONMENT === 'dev';
}

// ── the write allow-list + per-knob validation specs ─────────────────────────

export type KnobType = 'boolean' | 'number' | 'cron' | 'enum';
export type KnobGroup = 'sim' | 'pacing' | 'budget' | 'polling' | 'models';

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

/**
 * The curated knob set the dev inspector may write. The `recruiter_sim_*` keys
 * (the sim's own dial) plus the dev-loop pacing keys the owner asked to expose
 * so the whole proactive loop can be sped up for a watchable dev session. Every
 * entry is a `preferences`-tier key whose default lives in config/defaults.json.
 */
export const KNOB_SPECS: Record<string, KnobSpec> = {
  // ── the recruiter-sim dial (SIM_KNOB_KEYS) ──
  recruiter_sim_enabled: { type: 'boolean', group: 'sim', label: 'Sim enabled' },
  recruiter_sim_tick_interval_sec: { type: 'number', group: 'sim', label: 'Tick interval (s)', min: 5, max: 3600 },
  recruiter_sim_min_step_sec: { type: 'number', group: 'sim', label: 'Min step (s)', min: 1, max: 604_800 },
  recruiter_sim_max_step_sec: { type: 'number', group: 'sim', label: 'Max step (s)', min: 1, max: 604_800 },
  recruiter_sim_seed_interval_sec: { type: 'number', group: 'sim', label: 'Seed interval (s)', min: 5, max: 604_800 },
  recruiter_sim_max_concurrent: {
    type: 'number',
    group: 'sim',
    label: 'Max concurrent',
    min: 0,
    max: 100,
    integer: true,
  },
  recruiter_sim_screen_pass_rate: {
    type: 'number',
    group: 'sim',
    label: 'Screen pass rate',
    min: 0,
    max: 1,
    note: 'Fraction of applications that advance past the confirmation to a screen; the rest get an early rejection.',
  },
  recruiter_sim_offer_probability: { type: 'number', group: 'sim', label: 'Offer probability', min: 0, max: 1 },
  recruiter_sim_rejection_probability: { type: 'number', group: 'sim', label: 'Rejection probability', min: 0, max: 1 },
  recruiter_sim_ghost_probability: { type: 'number', group: 'sim', label: 'Ghost probability', min: 0, max: 1 },
  recruiter_sim_noise_ratio: { type: 'number', group: 'sim', label: 'Noise ratio', min: 0, max: 1 },
  recruiter_sim_daily_budget_usd: { type: 'number', group: 'sim', label: 'Sim daily budget (USD)', min: 0, max: 100 },
  // ── dev-loop pacing (crons) ──
  funnel_curator_cron: { type: 'cron', group: 'pacing', label: 'Funnel curator cron', note: CRON_NOTE },
  close_detection_cron: { type: 'cron', group: 'pacing', label: 'Close detection cron', note: CRON_NOTE },
  killer_match_cron: { type: 'cron', group: 'pacing', label: 'Killer-match cron', note: CRON_NOTE },
  daily_briefing_time: { type: 'cron', group: 'pacing', label: 'Daily briefing cron', note: CRON_NOTE },
  // ── dev cost caps ──
  owner_daily_llm_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Owner daily LLM budget (USD)',
    min: 0,
    max: 1000,
  },
  sandbox_daily_global_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Sandbox daily budget (USD)',
    min: 0,
    max: 1000,
  },
  // ── poll intervals ──
  gmail_poll_interval_sec: { type: 'number', group: 'polling', label: 'Gmail poll interval (s)', min: 10, max: 86_400 },
  calendar_poll_interval_sec: {
    type: 'number',
    group: 'polling',
    label: 'Calendar poll interval (s)',
    min: 10,
    max: 86_400,
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
  const ids = state.apps.map((a) => a.appId);
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
  const apps: SimAppView[] = state.apps.map((a) => ({
    ...a,
    totalStages: STAGE_CLASSIFICATIONS.length,
    upcoming: simUpcoming(a),
  }));
  return { enabled, lastSeedAtMs: state.lastSeedAtMs, apps, applications, pauseState: getPauseState() };
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

// ── on-demand funnel-curator sweep (§24.43c) ─────────────────────────────────

const SWEEP_PROMPT = '[scheduled trigger: funnel-curator]';

export interface DevSweepOutcome {
  status: number;
  body: unknown;
}

/**
 * Insert a ONE-SHOT funnel-curator trigger row into an inbound DB: the same
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
 *      funnel-curator]` task so the orchestrator fetches any NEW mail; that run's
 *      persist auto-converts via the same path (funnel-actions hook). Skipped (no
 *      error) when there's no active owner session yet, or while halted/paused.
 */
export async function applyDevSweep(): Promise<DevSweepOutcome> {
  const db = getDb();
  const applied = applyFunnelFromEmailEvents(db);
  // Score win_confidence with intelligence AFTER the convert (it reads the
  // just-applied stages). Best-effort + Portkey-gated — never throws.
  const wc = await scoreWinConfidence(db);

  let sweepEnqueued = false;
  const group = getAgentGroupByFolder('career-pilot');
  const session = group ? findSessionByAgentGroup(group.id) : undefined;
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
  'why_this_exists',
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
