/**
 * Migration 137 — pipeline audit vocabulary (STRATEGY.md §24.77 D3).
 *
 * The visitor-facing rename "funnel" → "pipeline" (§24.59) was display-aliased
 * in the frontend until now; this migration makes the stored data natively new
 * so the FE alias-mapping layer can be deleted (a raw `pipeline` category and
 * `pipeline-scribe` agent_name render with no mapping).
 *
 * Two value rewrites, both on the PUBLIC projection (`public_audit_trail`) only:
 *   1. `category`  'funnel'        → 'pipeline'        (the stage-update lane)
 *   2. `agent_name` of historical subagent_progress rows, to the post-rename
 *      ids: 'funnel-curator' → 'pipeline-scribe' (§24.59), 'prep-interview' →
 *      'build-interview-kit' (§24.53). New rows already carry the real names.
 *
 * Scope-bounded to the public read-model: the PRIVATE truth tables keep their
 * internal "funnel" naming (the `funnel_events` / `funnel_curator_output` table
 * names, the `funnel-curator` recurring-series id, the `/api/funnel` URL) —
 * renaming those is heavy migration / deployed-state breakage for zero visitor
 * benefit (the §24.77 in/out boundary).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration137: Migration = {
  version: 137,
  name: 'career-pilot-pipeline-audit-vocab',
  up(db: Database.Database) {
    db.exec(`
      UPDATE public_audit_trail SET category   = 'pipeline'           WHERE category   = 'funnel';
      UPDATE public_audit_trail SET agent_name = 'pipeline-scribe'    WHERE agent_name = 'funnel-curator';
      UPDATE public_audit_trail SET agent_name = 'build-interview-kit' WHERE agent_name = 'prep-interview';
    `);
  },
};
