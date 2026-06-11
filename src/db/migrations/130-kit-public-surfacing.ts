/**
 * Migration 130 — interview-kit public surfacing (STRATEGY.md §24.65).
 *
 * Three pieces:
 *  - `interview_kits.markdown` (private): the kit's source markdown, captured at
 *    persist time so the public projection (and reveal flips) never need a Drive
 *    read. NULL for kits persisted before this migration (backfilled best-effort
 *    on the box via Drive export; metadata-only until then).
 *  - `public_funnel_view.kits_json`: a sanit-safe per-application kit-metadata
 *    array for the /pipeline drawer ({round, interview_type, interview_at,
 *    status, created_at, has_content} — enums + timestamps only).
 *  - `public_kit_view`: the /kit dossier read-model — one row per
 *    (application_id, round), holding the policy-gated `sections_json`
 *    projection. Deliberately NO title and NO drive_url columns: both carry the
 *    real company name and never reach a public surface.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration130: Migration = {
  version: 130,
  name: 'career-pilot-kit-public-surfacing',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE interview_kits ADD COLUMN markdown TEXT;
      ALTER TABLE public_funnel_view ADD COLUMN kits_json TEXT;

      CREATE TABLE public_kit_view (
        application_id  TEXT NOT NULL,
        round           TEXT NOT NULL,              -- 'SCREENING' | 'TECH_SCREEN' | 'SYS_DESIGN' | 'FINAL'
        interview_type  TEXT NOT NULL,
        interview_at    TEXT,                       -- null ⇒ TBD
        status          TEXT NOT NULL,              -- 'active' | 'archived'
        sections_json   TEXT NOT NULL,              -- [{id,title,part,kind,body?,item_count?,withheld_reason?}]
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (application_id, round)
      );
    `);
  },
};
