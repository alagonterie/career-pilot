/**
 * Migration 104 — preferences table.
 *
 * Owner-tunable runtime configuration with hot-reload via NanoClaw's
 * native system messages. See STRATEGY.md §20 for the four-tier config
 * model (env / preferences / system_modes / defaults.json) and §20.2 for
 * the hot-reload mechanism.
 *
 * This migration only creates the empty table. config/defaults.json supplies
 * the runtime defaults — the host getConfig() helper (src/get-config.ts) reads
 * it directly as the fallback tier, so preferences need not be pre-seeded; a
 * row is created when the owner edits a preference (or by setup seeding, once
 * that lands).
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration104: Migration = {
  version: 104,
  name: 'career-pilot-preferences',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE preferences (
        key                 TEXT PRIMARY KEY,
        value               TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
    `);
  },
};
