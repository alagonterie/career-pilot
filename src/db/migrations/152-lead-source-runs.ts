/**
 * Migration 152 — lead_source_runs (STRATEGY.md §24.200 D5, §24.201 D6).
 *
 * One row per sourcing run, so the Leads tab can show what the last run did and
 * health can tell a live sweep from a dead one. `kind` is 'sweep' (the host's
 * employer-board sweep) or 'search' (one search-supplement call's refusals).
 *
 *   - `ok` is NULL while a sweep is running, then 1/0 when it finishes.
 *   - `trigger` — 'schedule' | 'manual'.
 *   - counts — boards fetched ok / failed; leads new, refreshed (last_seen_at
 *     stamped), closed (absent), reopened.
 *   - JSON columns — `rejected_json` {reason: count} (filter, age, tombstone,
 *     cap, link_kind, ...); `rejected_by_site_json` {site: count} for search;
 *     `failing_boards_json` [{company, ats, error}]; `queued_absent_json` — queued
 *     leads whose posting came down (surfaced, never auto-closed).
 *
 * Cleared by the dev data reset (listed ahead of job_leads): it describes the
 * pool the reset rebuilds.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration152: Migration = {
  version: 152,
  name: 'career-pilot-lead-source-runs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE lead_source_runs (
        id                    TEXT PRIMARY KEY,
        kind                  TEXT NOT NULL DEFAULT 'sweep',
        trigger               TEXT NOT NULL DEFAULT 'schedule',
        started_at            TEXT NOT NULL,
        finished_at           TEXT,
        ok                    INTEGER,
        error                 TEXT,
        boards_ok             INTEGER NOT NULL DEFAULT 0,
        boards_failed         INTEGER NOT NULL DEFAULT 0,
        new_count             INTEGER NOT NULL DEFAULT 0,
        refreshed_count       INTEGER NOT NULL DEFAULT 0,
        closed_count          INTEGER NOT NULL DEFAULT 0,
        reopened_count        INTEGER NOT NULL DEFAULT 0,
        rejected_json         TEXT NOT NULL DEFAULT '{}',
        rejected_by_site_json TEXT NOT NULL DEFAULT '{}',
        failing_boards_json   TEXT NOT NULL DEFAULT '[]',
        queued_absent_json    TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX idx_lead_source_runs_kind_started ON lead_source_runs(kind, started_at);
    `);
  },
};
