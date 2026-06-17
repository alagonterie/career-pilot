/**
 * Migration 138 — rename candidate_profile.why_this_exists → search_goals
 * (STRATEGY.md §24.101).
 *
 * `why_this_exists` ("Why this exists") was an orphaned onboarding field: the
 * public /about page is static and never rendered it, and render-persona
 * excluded it from the agent context — so it was collected and went nowhere.
 * Repurposed as the candidate's job-search goals ("My goals"), now fed to the
 * agent. RENAME COLUMN preserves any value the owner already entered.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration138: Migration = {
  version: 138,
  name: 'career-pilot-rename-search-goals',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE candidate_profile RENAME COLUMN why_this_exists TO search_goals;`);
  },
};
