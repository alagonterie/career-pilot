/**
 * Migration 141 — candidate_profile.protected_terms (STRATEGY.md §24.134d).
 *
 * A candidate-owned KEEP-LIST for the §24.134a kit entity-redaction belt: a JSON
 * array of terms the candidate considers their OWN (past employers, personal
 * project names) that must NEVER be redacted on the public surface. The belt
 * detects company-identifying entities with an LLM; the LLM is fuzzy and
 * sometimes flags the candidate's former employer. This list is the
 * deterministic guarantee — any detected token matching a protected term is
 * removed from the redaction set, so it is always kept regardless of the model.
 *
 * Non-hardcoded by construction: the values are runtime DATA the owner sets
 * (via `update_profile_field`), never code. Empty/NULL = no keep-list (today's
 * behavior). Mirrors the `target_roles` shape (JSON array as text).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration141: Migration = {
  version: 141,
  name: 'career-pilot-candidate-protected-terms',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE candidate_profile ADD COLUMN protected_terms TEXT;`);
  },
};
