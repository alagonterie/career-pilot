/**
 * Migration 127 — interview_kits table.
 *
 * Per-interview "mock-interview kit" artifacts (STRATEGY.md §24.53), materialized
 * as Google Docs in the dedicated career-account Drive (drive.file scope). One row
 * per (application_id, round): the orchestrator surfaces drive_url later (joined
 * into the funnel read-model) and the cleanup sweep archives it on terminal/stale.
 * Private — real company names, never sanitized (not a public surface).
 *
 * Schema reference: STRATEGY.md §3 + §24.53.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration127: Migration = {
  version: 127,
  name: 'career-pilot-interview-kits',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE interview_kits (
        id                  TEXT PRIMARY KEY,
        application_id      TEXT NOT NULL REFERENCES applications(id),
        round               TEXT NOT NULL,              -- the interview status that triggered it:
                                                        -- 'SCREENING' | 'TECH_SCREEN' | 'SYS_DESIGN' | 'FINAL'
        interview_type      TEXT NOT NULL,              -- derived from round: recruiter_screen
                                                        -- | technical_screen | system_design | final_round
        drive_file_id       TEXT NOT NULL,              -- the Google Doc id (drive.file-scoped, app-owned)
        drive_url           TEXT NOT NULL,              -- human-openable Doc link
        title               TEXT NOT NULL,              -- "Interview Kit — <Company> — <Round> — <date>"
        interview_at        TEXT,                       -- best-effort from calendar/curator; null ⇒ TBD
        status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
        created_at          TEXT NOT NULL,
        archived_at         TEXT
      );

      CREATE INDEX idx_interview_kits_app ON interview_kits(application_id, status);
      CREATE UNIQUE INDEX idx_interview_kits_app_round ON interview_kits(application_id, round);
    `);
  },
};
