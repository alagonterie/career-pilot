/**
 * Migration 147 — retire the old Opus model IDs (STRATEGY.md §24.195).
 *
 * `MODEL_OPTIONS` now offers exactly one Opus (`claude-opus-5-5`). The knob
 * writer validates against that list but the readers do not, so a `preferences`
 * row still naming a retired Opus would keep running it while `/admin` could no
 * longer display or re-select it. This moves every such stored choice onto the
 * one remaining Opus.
 *
 * Matched by VALUE across all keys rather than by a key list, so a model knob
 * added after this was written can't be missed. Idempotent, and a no-op on a DB
 * with no such rows (or no `preferences` table yet).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const RETIRED_OPUS_MODELS = ['claude-opus-4-8', 'claude-opus-5'] as const;
export const CURRENT_OPUS_MODEL = 'claude-opus-5-5';

export const migration147: Migration = {
  version: 147,
  name: 'career-pilot-retire-old-opus-models',
  up(db: Database.Database) {
    const hasPreferences = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preferences'")
      .get();
    if (!hasPreferences) return;
    const update = db.prepare('UPDATE preferences SET value = ?, updated_at = ? WHERE value = ?');
    const now = new Date().toISOString();
    for (const retired of RETIRED_OPUS_MODELS) update.run(CURRENT_OPUS_MODEL, now, retired);
  },
};
