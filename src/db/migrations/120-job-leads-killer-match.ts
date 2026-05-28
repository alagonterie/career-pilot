import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration120: Migration = {
  version: 120,
  name: 'career-pilot-job-leads-killer-match',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE job_leads ADD COLUMN killer_match_pushed_at TEXT;

      CREATE INDEX idx_job_leads_killer_match_pending
        ON job_leads(rules_score DESC, first_seen_at DESC)
        WHERE killer_match_pushed_at IS NULL AND closed_at IS NULL;
    `);
  },
};
