/**
 * Migration 106 — system_modes table.
 *
 * Operational state with hot-reload. The flags here gate every external
 * action the system can take. Three keys are special:
 *
 *   - 'live_mode'    — false (shadow / dry-run) | true (real outreach)
 *   - 'pause_state'  — 'active' | 'paused' | 'halted' | 'killswitch'
 *   - 'pause_reason' — optional human-readable reason
 *
 * Implemented by src/modules/portal/system-modes.ts. Hot-reload propagates
 * to running containers via NanoClaw native system messages within ~5s
 * (see STRATEGY.md §11 + §20.2).
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration106: Migration = {
  version: 106,
  name: 'career-pilot-system-modes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE system_modes (
        key                 TEXT PRIMARY KEY,
        value               TEXT NOT NULL,
        changed_at          TEXT NOT NULL,
        changed_by          TEXT
      );
    `);
  },
};
