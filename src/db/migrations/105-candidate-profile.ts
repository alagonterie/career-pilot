/**
 * Migration 105 — candidate_profile table.
 *
 * The owner's persona content. Single-row table (id=1). Content here drives
 * persona.local.md generation for the career-pilot agent group at session
 * start (see STRATEGY.md §4 — host-side hook).
 *
 * Privacy: this table is NEVER projected to public_audit_trail. The
 * sanitizer.ts loads display_name + full_name to redact them from any
 * agent output that leaks through.
 *
 * Schema reference: STRATEGY.md §3.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration105: Migration = {
  version: 105,
  name: 'career-pilot-candidate-profile',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE candidate_profile (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        full_name       TEXT,
        display_name    TEXT,
        bio             TEXT,
        target_roles    TEXT,
        location_pref   TEXT,
        comp_floor      INTEGER,
        master_resume   TEXT,
        skills          TEXT,
        github_url      TEXT,
        linkedin_url    TEXT,
        x_url           TEXT,
        website_url     TEXT,
        why_this_exists TEXT,
        headshot_path   TEXT,
        brand_color_hsl TEXT,
        updated_at      TEXT NOT NULL
      );
    `);
  },
};
