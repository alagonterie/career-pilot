/**
 * Migration 129 — public_audit_trail.cache_read_pct.
 *
 * The quantitative cache lane (STRATEGY.md §24.55): the share of a turn's
 * prompt-side tokens served from cache, 0–100, derived host-side from the
 * SDK's per-model usage at write time. Replaces the boolean `cache_hit` badge
 * in the UI (any agent turn ≥2 reads *some* cache, so the boolean carried no
 * information); `cache_hit` keeps being written for back-compat. NULL for
 * pre-migration rows and non-turn rows.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration129: Migration = {
  version: 129,
  name: 'career-pilot-cache-read-pct',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE public_audit_trail ADD COLUMN cache_read_pct INTEGER;`);
  },
};
