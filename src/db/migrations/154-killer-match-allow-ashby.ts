/**
 * Migration 154 — add 'ashby' to a stored killer-match source allow-list
 * (STRATEGY.md §24.200 D6d).
 *
 * The shipped default gains 'ashby' in config/defaults.json, but an owner who
 * ever saved `killer_match_source_allow_list` has a `preferences` row that
 * shadows the default, and Ashby board leads would silently never alert. Append
 * it to that stored list. Left alone: a list that already has it, an empty list
 * (the owner turned alerts off on purpose), and a value that is not a JSON array.
 * Idempotent; a no-op without a `preferences` table or row.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const KILLER_MATCH_ALLOW_LIST_KEY = 'killer_match_source_allow_list';

export const migration154: Migration = {
  version: 154,
  name: 'career-pilot-killer-match-allow-ashby',
  up(db: Database.Database) {
    const hasPreferences = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preferences'")
      .get();
    if (!hasPreferences) return;
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(KILLER_MATCH_ALLOW_LIST_KEY) as
      | { value: string }
      | undefined;
    if (!row) return;
    let list: unknown;
    try {
      list = JSON.parse(row.value);
    } catch {
      return;
    }
    if (!Array.isArray(list) || list.length === 0 || list.includes('ashby')) return;
    db.prepare('UPDATE preferences SET value = ?, updated_at = ? WHERE key = ?').run(
      JSON.stringify([...list, 'ashby']),
      new Date().toISOString(),
      KILLER_MATCH_ALLOW_LIST_KEY,
    );
  },
};
