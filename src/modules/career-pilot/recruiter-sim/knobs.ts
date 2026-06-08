/**
 * Recruiter-sim knobs (Sub-milestone 9.3b, STRATEGY.md §24.40 D13).
 *
 * Reads the `recruiter_sim_*` tunables via the four-tier config model
 * (env > preferences > config/defaults.json). The dev control surface (§24.42)
 * writes a subset of these through the preferences tier so the owner can tune
 * the sim from the gated dev page — hence `SIM_KNOB_KEYS` as the write
 * allow-list for that endpoint.
 */
import type Database from 'better-sqlite3';

import { getConfig } from '../../../get-config.js';
import type { SimKnobs } from './types.js';

/** The full set of `recruiter_sim_*` keys (defaults live in config/defaults.json). */
export const SIM_KNOB_KEYS = [
  'recruiter_sim_enabled',
  'recruiter_sim_job_source',
  'recruiter_sim_pace',
  'recruiter_sim_max_concurrent',
  'recruiter_sim_screen_pass_rate',
  'recruiter_sim_offer_probability',
  'recruiter_sim_rejection_probability',
  'recruiter_sim_ghost_probability',
  'recruiter_sim_noise_ratio',
  'recruiter_sim_daily_budget_usd',
] as const;

/** A pace preset's timing bundle (config/defaults.json `recruiter_sim_pace_presets`). */
interface PacePreset {
  tick_interval_sec: number;
  min_step_sec: number;
  max_step_sec: number;
  seed_interval_sec: number;
  backdate: boolean;
}

/** Safe fallback if the presets object is missing/malformed — the current "fast" values. */
const FALLBACK_PACE: PacePreset = {
  tick_interval_sec: 20,
  min_step_sec: 30,
  max_step_sec: 150,
  seed_interval_sec: 90,
  backdate: true,
};

function isPacePreset(v: unknown): v is PacePreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.tick_interval_sec === 'number' &&
    typeof p.min_step_sec === 'number' &&
    typeof p.max_step_sec === 'number' &&
    typeof p.seed_interval_sec === 'number' &&
    typeof p.backdate === 'boolean'
  );
}

export function readSimKnobs(db: Database.Database): SimKnobs {
  // Pace is a preset selector (D17): resolve the timing bundle from
  // `recruiter_sim_pace_presets[pace]`, falling back to `fast` then a hardcoded
  // safe bundle. The four timing values are no longer individual knobs.
  const pace = getConfig<string>(db, 'recruiter_sim_pace');
  const presets = getConfig<Record<string, unknown>>(db, 'recruiter_sim_pace_presets') ?? {};
  const candidate = presets[pace] ?? presets.fast;
  const preset = isPacePreset(candidate) ? candidate : FALLBACK_PACE;
  const jobSource = getConfig<string>(db, 'recruiter_sim_job_source') === 'synthetic' ? 'synthetic' : 'real';

  return {
    enabled: getConfig<boolean>(db, 'recruiter_sim_enabled'),
    jobSource,
    tickIntervalSec: preset.tick_interval_sec,
    minStepSec: preset.min_step_sec,
    maxStepSec: preset.max_step_sec,
    seedIntervalSec: preset.seed_interval_sec,
    backdate: preset.backdate,
    maxConcurrent: getConfig<number>(db, 'recruiter_sim_max_concurrent'),
    screenPassRate: getConfig<number>(db, 'recruiter_sim_screen_pass_rate'),
    offerProbability: getConfig<number>(db, 'recruiter_sim_offer_probability'),
    rejectionProbability: getConfig<number>(db, 'recruiter_sim_rejection_probability'),
    ghostProbability: getConfig<number>(db, 'recruiter_sim_ghost_probability'),
    noiseRatio: getConfig<number>(db, 'recruiter_sim_noise_ratio'),
    dailyBudgetUsd: getConfig<number>(db, 'recruiter_sim_daily_budget_usd'),
  };
}
