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
  'recruiter_sim_tick_interval_sec',
  'recruiter_sim_min_step_sec',
  'recruiter_sim_max_step_sec',
  'recruiter_sim_seed_interval_sec',
  'recruiter_sim_max_concurrent',
  'recruiter_sim_screen_pass_rate',
  'recruiter_sim_offer_probability',
  'recruiter_sim_rejection_probability',
  'recruiter_sim_ghost_probability',
  'recruiter_sim_noise_ratio',
  'recruiter_sim_daily_budget_usd',
] as const;

export function readSimKnobs(db: Database.Database): SimKnobs {
  return {
    enabled: getConfig<boolean>(db, 'recruiter_sim_enabled'),
    tickIntervalSec: getConfig<number>(db, 'recruiter_sim_tick_interval_sec'),
    minStepSec: getConfig<number>(db, 'recruiter_sim_min_step_sec'),
    maxStepSec: getConfig<number>(db, 'recruiter_sim_max_step_sec'),
    seedIntervalSec: getConfig<number>(db, 'recruiter_sim_seed_interval_sec'),
    maxConcurrent: getConfig<number>(db, 'recruiter_sim_max_concurrent'),
    screenPassRate: getConfig<number>(db, 'recruiter_sim_screen_pass_rate'),
    offerProbability: getConfig<number>(db, 'recruiter_sim_offer_probability'),
    rejectionProbability: getConfig<number>(db, 'recruiter_sim_rejection_probability'),
    ghostProbability: getConfig<number>(db, 'recruiter_sim_ghost_probability'),
    noiseRatio: getConfig<number>(db, 'recruiter_sim_noise_ratio'),
    dailyBudgetUsd: getConfig<number>(db, 'recruiter_sim_daily_budget_usd'),
  };
}
