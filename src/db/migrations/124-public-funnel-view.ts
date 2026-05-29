/**
 * Migration 124 — public_funnel_view projection table.
 *
 * Sanitized current-state projection of `applications` (one row per
 * application), the read-model behind /api/funnel. public_audit_trail is an
 * append-only event log; the funnel surfaces (/ strip, /funnel board, /live
 * compact funnel) need current state per application. A maintained physical
 * table (not a SQL VIEW) lets the portal API SELECT * from a genuinely
 * public table with zero leak risk, and carries sanitized free-text
 * (published_learning) a column-level VIEW could not.
 *
 * Written by the host-side hook upsertPublicFunnelView (see
 * src/modules/portal/public-funnel-view.ts) on every applications /
 * funnel_events write — same best-effort, post-commit discipline as the
 * public_audit_trail mirror. The portal API reads only this view, never
 * `applications`.
 *
 * Timestamps only (applied_at / stage_entered_at / last_activity_at): the
 * "days in stage / pipeline" figures are computed at read time so a row
 * never goes stale.
 *
 * Schema reference: STRATEGY.md §3 + §24.14.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration124: Migration = {
  version: 124,
  name: 'career-pilot-public-funnel-view',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE public_funnel_view (
        application_id      TEXT PRIMARY KEY REFERENCES applications(id),
        application_ref     TEXT NOT NULL,
        public_state        TEXT NOT NULL,
        role_title          TEXT,
        status              TEXT NOT NULL,
        stage               TEXT NOT NULL,
        applied_at          TEXT,
        stage_entered_at    TEXT,
        last_activity_at    TEXT,
        win_confidence      INTEGER,
        published_learning  TEXT,
        updated_at          TEXT NOT NULL
      );

      CREATE INDEX idx_public_funnel_view_stage ON public_funnel_view(stage);
    `);
  },
};
