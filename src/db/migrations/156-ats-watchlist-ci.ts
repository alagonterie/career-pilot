/**
 * Migration 156 — the watchlist key is case-insensitive, and an owner's
 * "remove" is remembered (STRATEGY.md §24.201 D7, §24.202 D6).
 *
 * 1. Board slugs are case-insensitive on every ATS we read, and every lookup
 *    (`findBoard`) already matches `lower(token)`. But `UNIQUE (ats, token)` uses
 *    BINARY collation, so `Acme` and `acme` could be two rows — the second one
 *    escaping an owner's pause and the size cap. Rows that already collide are
 *    merged into the oldest one (an owner pause on any of them wins: the merged
 *    row stays paused), then a UNIQUE index on `(ats, lower(token))` makes the
 *    key case-insensitive. Writers insert with a target-less
 *    `ON CONFLICT DO NOTHING`, so either constraint stops a duplicate.
 *
 * 2. `ats_watchlist_removed` — boards the owner removed from the Watchlist tab.
 *    Remove deletes the row, so without a record the automatic growth paths (a
 *    search hit's board, "I applied") could not tell a removed board from one
 *    never seen and would add it back. Growth and the agent's discover skip a
 *    board listed here; only the owner re-adding it by URL clears the entry.
 *    `token` is stored lower-cased. Like `ats_watchlist`, not cleared by the dev
 *    data reset (it is the owner's configuration, not pipeline state).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration156: Migration = {
  version: 156,
  name: 'career-pilot-ats-watchlist-ci',
  up(db: Database.Database) {
    db.exec(`
      UPDATE ats_watchlist
         SET state = 'paused'
       WHERE id IN (SELECT MIN(id) FROM ats_watchlist GROUP BY ats, lower(token) HAVING COUNT(*) > 1)
         AND EXISTS (SELECT 1 FROM ats_watchlist d
                      WHERE d.ats = ats_watchlist.ats AND lower(d.token) = lower(ats_watchlist.token)
                        AND d.state = 'paused');

      DELETE FROM ats_watchlist
       WHERE id NOT IN (SELECT MIN(id) FROM ats_watchlist GROUP BY ats, lower(token));

      CREATE UNIQUE INDEX ux_ats_watchlist_ats_token_ci ON ats_watchlist(ats, lower(token));

      CREATE TABLE ats_watchlist_removed (
        ats        TEXT NOT NULL,
        token      TEXT NOT NULL,
        removed_at TEXT NOT NULL,
        PRIMARY KEY (ats, token)
      );
    `);
  },
};
