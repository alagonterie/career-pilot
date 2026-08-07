/**
 * Migration 144 — candidate_profile.searching_since (STRATEGY.md §24.188).
 *
 * The owner-settable anchor behind the hero's "searching since {Mon YYYY}"
 * segment. That segment was derived from the earliest application's applied_at,
 * which silently assumes the search has run CONTINUOUSLY since then — after a
 * deliberate pause it reads as months of inactivity. Only the owner knows when
 * the current search actually started, so this is owner-set data, never inferred
 * (the same rule site_lifecycle_state follows).
 *
 * Stored as a bare `YYYY-MM` — the same granularity the surface renders, so
 * there is no day/timezone boundary to get wrong between the SSR seed and the
 * client. NULL (the default) = no override: the derived earliest-applied_at
 * behavior, unchanged.
 *
 * Owner-only by construction: the column is editable from the /admin Persona tab
 * but is deliberately NOT in PROFILE_FIELDS, so the agent's update_profile_field
 * cannot set it.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration144: Migration = {
  version: 144,
  name: 'career-pilot-candidate-searching-since',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE candidate_profile ADD COLUMN searching_since TEXT;`);
  },
};
