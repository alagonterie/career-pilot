/**
 * Migration 128 — simulator_runs.trace_json.
 *
 * The run's dispatch trace (the `tool`/`subagent` TraceEvents the visitor
 * watched live), persisted on finalize so the `/simulator/results/:id` share
 * page can render an expandable "run activity" section (STRATEGY.md §24.31 Δ
 * 2026-06-10). JSON array as text; null for pre-migration rows and runs that
 * produced no dispatches. Public-safe by construction — the trace is the
 * visitor's own input + public web-tool calls (§24.20 sanitization note).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration128: Migration = {
  version: 128,
  name: 'career-pilot-simulator-trace',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE simulator_runs ADD COLUMN trace_json TEXT;`);
  },
};
