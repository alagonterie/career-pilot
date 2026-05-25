/**
 * Migration 107 — simulator_runs table.
 *
 * Cache of recent successful public-simulator runs. Used by /simulator to
 * show "recent runs" fallback when the live sandbox is rate-limited /
 * budget-exhausted / disabled.
 *
 * 30-day TTL enforced by a sweep in src/modules/portal/simulator.ts.
 * `shareable=0` indicates the visitor opted out of caching their run.
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration107: Migration = {
  version: 107,
  name: 'career-pilot-simulator-runs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE simulator_runs (
        id                  TEXT PRIMARY KEY,
        ts                  TEXT NOT NULL,
        visitor_company     TEXT,
        visitor_role        TEXT,
        jd_excerpt          TEXT,
        tailored_resume     TEXT,
        outreach_draft      TEXT,
        total_cost_cents    INTEGER,
        total_latency_ms    INTEGER,
        cache_hit_count     INTEGER,
        shareable           INTEGER DEFAULT 1,
        expires_at          TEXT
      );
    `);
  },
};
