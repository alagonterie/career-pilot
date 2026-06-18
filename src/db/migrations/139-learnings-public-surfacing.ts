/**
 * Migration 139 — learnings public surfacing (STRATEGY.md §24.117).
 *
 * `public_funnel_view.learnings_json`: a sanit-safe per-application array of
 * ALL published reflections ({kind, created_at, excerpt}, newest first) for the
 * /pipeline drawer's "Lessons learned" list — the rejection-as-fuel loop
 * (§24.107) made visible. The twin of §24.65's `kits_json`: computed inside
 * `upsertPublicFunnelView`, excerpts already sanitized (Pass 1 PII + Pass 2
 * company redaction) + truncated. The legacy single `published_learning` column
 * (latest excerpt) stays for back-compat.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration139: Migration = {
  version: 139,
  name: 'career-pilot-learnings-public-surfacing',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE public_funnel_view ADD COLUMN learnings_json TEXT;
    `);
  },
};
