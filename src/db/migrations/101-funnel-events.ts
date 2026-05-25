/**
 * Migration 101 — funnel_events table.
 *
 * Every state transition + agent action against an application. Source of
 * truth for the funnel race animation on /funnel and the timeline detail
 * panels. Sanitized projection mirrored to public_audit_trail via
 * src/modules/portal/public-audit.ts post-write hook.
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration101: Migration = {
  version: 101,
  name: 'career-pilot-funnel-events',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE funnel_events (
        id                  TEXT PRIMARY KEY,
        application_id      TEXT NOT NULL REFERENCES applications(id),
        kind                TEXT NOT NULL,
        from_status         TEXT,
        to_status           TEXT,
        payload             TEXT NOT NULL,
        source              TEXT NOT NULL,
        ts                  TEXT NOT NULL
      );

      CREATE INDEX idx_funnel_events_app ON funnel_events(application_id, ts DESC);
    `);
  },
};
