/**
 * Migration 151 — ats_watchlist (STRATEGY.md §24.200 D7).
 *
 * The employer boards the host sweeps, as a table instead of a hand-kept file.
 * `groups/career-pilot/data/ats-targets.json` is now read only by the boot-time
 * insert-missing seed (`ensureAtsWatchlistSeeded`, origin 'seed'); every reader
 * (`fetch_source`, the sweep, `discover_ats_board`) works from this table.
 *
 *   - `ats` + `token`  — the board identity, UNIQUE. Validated in application
 *                        code against the adapter list (no CHECK: adding an ATS
 *                        must not need a table rebuild).
 *   - `tier`           — 'A' | 'B' | 'C', `fetch_source`'s priority filter.
 *   - `origin`         — 'seed' | 'owner' | 'search' | 'applied': how it got here.
 *   - `state`          — 'active' (swept) | 'paused' (owner, e.g. "block company")
 *                        | 'absent' (retired after repeated "board gone" answers).
 *   - fetch bookkeeping — `last_ok_at`, `last_error`, `consecutive_failures`
 *                        (any failed fetch — health reads it), `consecutive_absent`
 *                        (only "board gone" answers, 404/410 — the ONLY thing
 *                        that drives retirement, so an outage never retires a
 *                        board), `leads_found`, `last_hit_at`.
 *
 * Not cleared by the dev data reset: it is configuration the owner grew, not
 * pipeline state.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration151: Migration = {
  version: 151,
  name: 'career-pilot-ats-watchlist',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE ats_watchlist (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        ats                  TEXT NOT NULL,
        token                TEXT NOT NULL,
        company              TEXT NOT NULL,
        tier                 TEXT NOT NULL DEFAULT 'B' CHECK (tier IN ('A', 'B', 'C')),
        origin               TEXT NOT NULL,
        state                TEXT NOT NULL DEFAULT 'active',
        notes                TEXT,
        last_ok_at           TEXT,
        last_error           TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_absent   INTEGER NOT NULL DEFAULT 0,
        leads_found          INTEGER NOT NULL DEFAULT 0,
        last_hit_at          TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        UNIQUE (ats, token)
      );

      CREATE INDEX idx_ats_watchlist_state ON ats_watchlist(state);
    `);
  },
};
