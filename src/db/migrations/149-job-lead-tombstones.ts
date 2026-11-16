/**
 * Migration 149 — job_lead_tombstones (STRATEGY.md §24.200 D2).
 *
 * A hard `DELETE FROM job_leads` used to have no memory: the next scrape that
 * surfaced the same posting re-inserted it, so the owner's deleting never
 * converged. A tombstone remembers what was removed AND why, and the pre-insert
 * guard (`lead-guard.ts`, shared by every writer) consults it.
 *
 * `match` is the reach of the refusal:
 *   - 'id'          — refuses only the same (source, source_job_id).
 *   - 'fingerprint' — additionally refuses a payload from the same normalized
 *                     company whose SimHash is within `lead_tombstone_hamming_max`
 *                     bits (default 0 = exact). An all-zero fingerprint never
 *                     matches.
 *
 * A tombstone written because of the LINK (`reason` starting with 'link:') is
 * always id-only, and it refuses the posting only while it still arrives without
 * a direct link — the job was fine, only the link was bad, so the same posting
 * re-found with a direct link must be accepted. Fingerprint reach is reserved for
 * owner intent ("not interested" for role/company/other, an owner hard delete of
 * a direct lead).
 *
 * No foreign key to job_leads: the lead a tombstone describes is usually gone.
 * `company`/`title` are kept for the log line and for an owner reading the table;
 * company normalization happens in application code (same as the fingerprint
 * compare — SQLite has no popcount).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration149: Migration = {
  version: 149,
  name: 'career-pilot-job-lead-tombstones',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE job_lead_tombstones (
        id                  TEXT PRIMARY KEY,
        source              TEXT NOT NULL,
        source_job_id       TEXT NOT NULL,
        content_fingerprint TEXT,
        company             TEXT,
        title               TEXT,
        -- Why it was removed: 'link:<kind>', 'deleted', 'not_interested:<reason>'.
        reason              TEXT NOT NULL,
        -- 'id' | 'fingerprint' (see header).
        match               TEXT NOT NULL CHECK (match IN ('id', 'fingerprint')),
        created_at          TEXT NOT NULL
      );

      CREATE INDEX idx_job_lead_tombstones_key ON job_lead_tombstones(source, source_job_id);
      CREATE INDEX idx_job_lead_tombstones_match ON job_lead_tombstones(match);
    `);
  },
};
