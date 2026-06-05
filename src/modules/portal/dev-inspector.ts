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

import { getConfig } from '../../get-config.js';
import { type CandidateProfile, readCandidateProfile, renderPersona } from '../career-pilot/render-persona.js';
import { SIM_KNOB_KEYS } from '../career-pilot/recruiter-sim/knobs.js';
import type { SimState } from '../career-pilot/recruiter-sim/types.js';

/** The hard environment gate. Read at request time — see the module header. */
export function isDevEnv(): boolean {
  return process.env.ENVIRONMENT === 'dev';
}

// ── the write allow-list + per-knob validation specs ─────────────────────────

export type KnobType = 'boolean' | 'number' | 'cron';
export type KnobGroup = 'sim' | 'pacing' | 'budget' | 'polling';

export interface KnobSpec {
  type: KnobType;
  group: KnobGroup;
  label: string;
  /** Numeric bounds (inclusive), for `type: 'number'`. */
  min?: number;
  max?: number;
  integer?: boolean;
  /** Surfaced to the UI — e.g. cron changes only take effect on the next reclone. */
  note?: string;
}

const CRON_NOTE =
  'Saved immediately, but the running recurring task keeps its old cadence until its series is re-bootstrapped (next fresh session / reset:dev) — the bootstrap skips an existing task and the cron is copied onto the queued row at insert.';

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

export interface KnobWriteOutcome {
  status: number;
  body: unknown;
}

/**
 * Apply a `{ key, value }` knob write: validate against the allow-list + ranges,
 * persist to the preferences tier, and echo the coerced value. 400 on any
 * invalid/unknown input — nothing is written in that case.
 */
export function applyKnobWrite(db: Database.Database, raw: unknown): KnobWriteOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { key, value }' } };
  }
  const { key, value } = raw as { key?: unknown; value?: unknown };
  if (typeof key !== 'string') {
    return { status: 400, body: { error: 'missing or non-string "key"' } };
  }
  const res = validateKnobWrite(key, value);
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
  type: KnobType;
  group: KnobGroup;
  label: string;
  min: number | null;
  max: number | null;
  integer: boolean;
  note: string | null;
}

/** Current value + metadata for every writable knob (drives the control UI). */
export function buildDevKnobs(db: Database.Database): { knobs: KnobView[] } {
  const knobs = DEV_INSPECTOR_WRITABLE_KEYS.map<KnobView>((key) => {
    const spec = KNOB_SPECS[key];
    return {
      key,
      value: getConfig(db, key),
      type: spec.type,
      group: spec.group,
      label: spec.label,
      min: spec.min ?? null,
      max: spec.max ?? null,
      integer: spec.integer ?? false,
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

/**
 * The sim's live scenario state (from the sidecar) joined to the `applications`
 * rows it seeded — so the page can show both the sim's internal funnel walk and
 * the real funnel position the curator advanced the rows to.
 */
export function buildDevState(
  db: Database.Database,
  state: SimState,
): {
  enabled: boolean;
  lastSeedAtMs: number;
  apps: SimState['apps'];
  applications: SimApplicationRow[];
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
  return { enabled, lastSeedAtMs: state.lastSeedAtMs, apps: state.apps, applications };
}

// ── persona / onboarding ──────────────────────────────────────────────────────

/** The onboarding interview order (one field per turn) — mirrors render-persona's sentinel. */
export const ONBOARDING_FIELD_ORDER = [
  'full_name',
  'target_roles',
  'comp_floor',
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

function fieldFilled(profile: CandidateProfile, field: string): boolean {
  switch (field) {
    case 'target_roles':
      return jsonArrayNonEmpty(profile.target_roles);
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
