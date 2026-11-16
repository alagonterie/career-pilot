/**
 * Migration 153 — search_quota_usage (STRATEGY.md §24.200 D8).
 *
 * The spend gate for the search supplement: `search_jobs` reserves the result
 * pages it is about to fetch, and the host refuses past `search_daily_page_cap`
 * or past `search_monthly_quota` since `search_quota_period_anchor_day`. One row
 * per UTC day (`YYYY-MM-DD`). A dedicated counter rather than request_telemetry,
 * which is pruned, written best-effort and can be switched off.
 *
 * Not cleared by the dev data reset — a reset must not hand back provider quota
 * that was really spent.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration153: Migration = {
  version: 153,
  name: 'career-pilot-search-quota-usage',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE search_quota_usage (
        day        TEXT PRIMARY KEY,
        pages      INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
