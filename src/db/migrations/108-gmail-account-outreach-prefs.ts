/**
 * Migration 108 — `candidate_profile.gmail_account` + outreach attribution
 * preferences.
 *
 * Lands the host-side schema half of Phase 2.3 sub-milestone — see
 * `.specs/STRATEGY.md §24.3` items 5 and 6.
 *
 * - `candidate_profile.gmail_account` (TEXT, nullable) — the owner's
 *   Gmail address. The OAuth refresh token itself lives in the OneCLI
 *   vault; only the address sits in the DB so the orchestrator can echo
 *   "drafting from your Gmail (...)" in user-facing replies.
 *
 * - `preferences.outreach_show_ai_attribution` (default `true`) — gates
 *   the transparency footer the orchestrator appends to outreach drafts.
 *   Default-on since the project's mission is showcase.
 *
 * - `preferences.outreach_attribution_template` — the template the
 *   orchestrator appends to the draft body when the flag is true.
 *   `<portal_url>` is substituted at draft time.
 *
 * `INSERT OR IGNORE` is intentional — re-running this migration on a DB
 * that somehow already had the rows (manual seeding during dev) is a
 * no-op rather than a constraint error.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration108: Migration = {
  version: 108,
  name: 'career-pilot-gmail-account-outreach-prefs',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE candidate_profile ADD COLUMN gmail_account TEXT;`);

    const now = new Date().toISOString();
    const insertPref = db.prepare(`INSERT OR IGNORE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)`);
    insertPref.run('outreach_show_ai_attribution', 'true', now);
    insertPref.run(
      'outreach_attribution_template',
      '\n\n---\n_This draft was prepared by career-pilot, my autonomous job-search agent system. See it work live at <portal_url>._',
      now,
    );
  },
};
