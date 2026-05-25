/**
 * Migration 102 — public_audit_trail table.
 *
 * Sanitized projection consumed by the public API at api.hire.<DOMAIN>.
 * Written by src/modules/portal/public-audit.ts as a post-write hook on
 * applications/funnel_events tables. Never contains real company names —
 * always references applications by obfuscated_label.
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration102: Migration = {
  version: 102,
  name: 'career-pilot-public-audit-trail',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE public_audit_trail (
        id                  TEXT PRIMARY KEY,
        ts                  TEXT NOT NULL,
        category            TEXT NOT NULL,
        agent_name          TEXT,
        proactive           INTEGER DEFAULT 0,
        application_ref     TEXT,
        model_used          TEXT,
        tokens              INTEGER,
        cost_cents          INTEGER,
        cache_hit           INTEGER DEFAULT 0,
        latency_ms          INTEGER,
        summary             TEXT NOT NULL,
        details_json        TEXT
      );

      CREATE INDEX idx_audit_ts ON public_audit_trail(ts DESC);
      CREATE INDEX idx_audit_category ON public_audit_trail(category, ts DESC);
    `);
  },
};
