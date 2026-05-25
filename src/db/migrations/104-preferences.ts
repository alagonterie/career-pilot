/**
 * Migration 104 — preferences table.
 *
 * Owner-tunable runtime configuration with hot-reload via NanoClaw's
 * native system messages. See STRATEGY.md §20 for the four-tier config
 * model (env / preferences / system_modes / defaults.json) and §20.2 for
 * the hot-reload mechanism.
 *
 * Seed values are loaded from config/defaults.json by scripts/setup-local.ts
 * during onboarding, or by `pnpm run migrations` on the production VM.
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
