/**
 * Migration 133 — candidate_profile work-page projection columns (STRATEGY.md
 * §24.71 / Phase 9.4b-1).
 *
 * The `/work` page (+ landing hero) renders the candidate's resume content. Per
 * §24.71 the agent COMPOSES that page at write-time into the frontend's
 * `WorkProfile` shape and persists it here; `GET /api/profile` projects this
 * blob deterministically at read-time (no LLM in the SSR hot path). Stored as
 * one JSON blob — not wide structured columns — because the page is a *view* the
 * agent regenerates; the authoritative source stays `master_resume` + the basics
 * fields. Provenance columns make the on-page "composed by the agent" marker
 * (9.4b-2) honest. All nullable: an un-composed profile → null → the portal
 * falls back to its typed placeholder.
 *
 * `work_profile_source`: 'agent' (the composer wrote it), 'owner' (hand-edited),
 * or 'seed' (seeded by hand before the composer ships, 9.4b-1).
 *
 * Schema reference: STRATEGY.md §24.71 D3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration133: Migration = {
  version: 133,
  name: 'career-pilot-candidate-profile-work-page',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE candidate_profile ADD COLUMN work_profile_json TEXT;
      ALTER TABLE candidate_profile ADD COLUMN work_profile_generated_at TEXT;
      ALTER TABLE candidate_profile ADD COLUMN work_profile_source TEXT;
    `);
  },
};
