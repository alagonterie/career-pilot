/**
 * Migration 148 — retire the pre-5.5 Haiku and Sonnet model IDs (STRATEGY.md §24.197).
 *
 * `MODEL_OPTIONS` now offers one model per tier. The knob writer validates
 * against that list but the readers do not, so a `preferences` row still naming
 * a retired model would keep running it while `/admin` could no longer display
 * or re-select it. This moves every such stored choice onto its tier's 5.5
 * model, exactly as migration 147 did for Opus.
 *
 * Matched by VALUE across all keys rather than by a key list, so a model knob
 * added after this was written can't be missed. Idempotent, and a no-op on a DB
 * with no such rows (or no `preferences` table yet).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const RETIRED_MODEL_SUCCESSORS: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-sonnet-4-6': 'claude-sonnet-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
};

export const migration148: Migration = {
  version: 148,
  name: 'career-pilot-retire-old-haiku-sonnet-models',
  up(db: Database.Database) {
    const hasPreferences = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preferences'")
      .get();
    if (!hasPreferences) return;
    const update = db.prepare('UPDATE preferences SET value = ?, updated_at = ? WHERE value = ?');
    const now = new Date().toISOString();
    for (const [retired, successor] of Object.entries(RETIRED_MODEL_SUCCESSORS)) update.run(successor, now, retired);
  },
};
