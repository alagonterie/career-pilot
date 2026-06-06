/**
 * Migration 126 — win_confidence_rationale.
 *
 * The intelligent win_confidence score (win-confidence.ts) now carries a
 * one-sentence Gen-AI rationale explaining the number, surfaced in the
 * `/funnel` detail panel. Stored on `applications` (the private source) and
 * projected, sanitized, into `public_funnel_view` (the public read-model) —
 * same private→public discipline as `published_learning`.
 *
 * Schema reference: STRATEGY.md §24.43.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration126: Migration = {
  version: 126,
  name: 'career-pilot-win-confidence-rationale',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE applications ADD COLUMN win_confidence_rationale TEXT;
      ALTER TABLE public_funnel_view ADD COLUMN win_confidence_rationale TEXT;
    `);
  },
};
