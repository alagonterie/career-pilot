/**
 * Migration 134 — candidate_profile.public_email (STRATEGY.md §24.71 / 9.4b-3).
 *
 * The candidate's PUBLIC contact email — the one shown on `/contact` + the
 * landing teaser — distinct from `gmail_account` (the agent's OAuth identity).
 * Sourced into the site-wide `identity` projection (`GET /api/profile`), SSR'd
 * everywhere, optional (omitted when null → no broken link). Because the dev and
 * prod stacks have separate DBs, this column gives the per-environment public
 * address for free (dev row vs prod row) with no env-specific code.
 *
 * Schema reference: STRATEGY.md §24.71 (9.4b-3 identity projection).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration134: Migration = {
  version: 134,
  name: 'career-pilot-candidate-profile-public-email',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE candidate_profile ADD COLUMN public_email TEXT;`);
  },
};
