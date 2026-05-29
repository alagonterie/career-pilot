/**
 * Migration 106 — system_modes table.
 *
 * Operational state that gates every external action the system can take.
 * Three keys are special:
 *
 *   - 'live_mode'    — false (shadow / dry-run) | true (real outreach)
 *   - 'pause_state'  — 'active' | 'paused' | 'halted' | 'killswitch'
 *   - 'pause_reason' — optional human-readable reason
 *
 * Read/written by src/modules/portal/system-modes.ts (readers: 5.1; writers
 * setPauseState/setLiveMode: 5.4a). Enforcement is host-side: the container-
 * runner spawn gate, the host-sweep proactive-wake gate, and the recurrence
 * fanout gate. The hot-reload mechanism that would push changes into a *running*
 * container mid-turn (§16.6 / §20.2) is DEFERRED as a unit — the container has
 * no consumer for it yet. See STRATEGY.md §24.18 for the finding.
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
