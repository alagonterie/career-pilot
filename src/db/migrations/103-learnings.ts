/**
 * Migration 103 — learnings table.
 *
 * Rejection-as-fuel + sibling feedback loops. Stores reflections after
 * outcomes (interviews, offers, rejections) so the orchestrator can
 * surface relevant prior learnings when researching similar companies.
 *
 * Owner can opt to publish individual learnings (`reflection_published=1`)
 * to /funnel detail panels for transparency.
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration103: Migration = {
  version: 103,
  name: 'career-pilot-learnings',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE learnings (
        id                   TEXT PRIMARY KEY,
        application_id       TEXT REFERENCES applications(id),
        kind                 TEXT NOT NULL,
        role_category        TEXT,
        reflections          TEXT NOT NULL,
        reflection_published INTEGER DEFAULT 0,
        created_at           TEXT NOT NULL
      );

      CREATE INDEX idx_learnings_role_cat ON learnings(role_category);
    `);
  },
};
