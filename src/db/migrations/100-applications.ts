/**
 * Migration 100 — applications table.
 *
 * The real, private job-application records. Public projection lives in
 * public_audit_trail (migration 102) sanitized via src/modules/portal/sanitizer.ts.
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration100: Migration = {
  version: 100,
  name: 'career-pilot-applications',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE applications (
        id                  TEXT PRIMARY KEY,
        company_name        TEXT NOT NULL,
        company_aliases     TEXT,
        obfuscated_label    TEXT NOT NULL,
        public_state        TEXT NOT NULL DEFAULT 'obfuscated',
        role_title          TEXT NOT NULL,
        job_url             TEXT,
        jd_text             TEXT,
        jd_analyzed         TEXT,
        status              TEXT NOT NULL,
        win_confidence      INTEGER,
        applied_at          TEXT,
        last_activity_at    TEXT,
        created_at          TEXT NOT NULL
      );

      CREATE INDEX idx_applications_status ON applications(status);
      CREATE INDEX idx_applications_public ON applications(public_state);
    `);
  },
};
