/**
 * Migration 150 — applications.sent_resume_id (STRATEGY.md §24.202 D8).
 *
 * "I applied" on the Leads tab creates the application from the lead in one
 * step, and the owner may say which tailored résumé went out with it. This
 * column records that choice so the pipeline knows what the employer actually
 * received.
 *
 * Deliberately NOT a foreign key to tailored_resumes: that table cascades on
 * lead deletion (§24.191), and an application must never fail to write — or be
 * blocked from deleting its lead's résumés — because of a provenance pointer.
 * The writer validates the id (a `ready` résumé of the same lead) instead.
 *
 * Nullable: every application created before this, and every one the agent
 * creates, has no recorded résumé. Idempotent via the PRAGMA guard.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration150: Migration = {
  version: 150,
  name: 'career-pilot-applications-sent-resume',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('applications')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('sent_resume_id')) {
      db.prepare('ALTER TABLE applications ADD COLUMN sent_resume_id TEXT').run();
    }
  },
};
