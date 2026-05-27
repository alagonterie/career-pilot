/**
 * Migration 110 — job_leads table.
 *
 * The continuously-maintained pool the orchestrator queries for discovered
 * roles. Written by the `scrape-jobs` subagent; read by the orchestrator at
 * user-trigger time in v1.0 and at daily-briefing time in Phase 3+.
 *
 * Not the same as `applications`: a lead is "we noticed this exists"; an
 * application is "we engaged with it." Leads -> applications bridge via
 * `application_id` (NULL until promoted).
 *
 * Schema reference: STRATEGY.md §3 + §24.5.
 *
 * Phase 2.5 v1.0 ships: schema + within-source dedup (UNIQUE on
 * (source, source_job_id)) + cheap host-computed `rules_score` at insert.
 * Cross-source SimHash clustering, LLM scoring at draw time, close-detection
 * sweep, and killer-match push all defer to Phase 3+ per §24.5 out-of-scope.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration110: Migration = {
  version: 110,
  name: 'career-pilot-job-leads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE job_leads (
        id                     TEXT PRIMARY KEY,

        source                 TEXT NOT NULL,
        source_board_token     TEXT,
        source_job_id          TEXT NOT NULL,
        source_url             TEXT NOT NULL,
        apply_url              TEXT,

        content_fingerprint    TEXT NOT NULL,
        fingerprint_cluster_id TEXT,

        title                  TEXT NOT NULL,
        company                TEXT NOT NULL,
        company_domain         TEXT,
        location_raw           TEXT,
        is_remote              INTEGER,
        workplace_type         TEXT,
        remote_region          TEXT,
        employment_type        TEXT,

        comp_min_usd           INTEGER,
        comp_max_usd           INTEGER,
        comp_currency          TEXT DEFAULT 'USD',
        comp_period            TEXT,
        has_equity             INTEGER,

        description_html       TEXT,
        description_text       TEXT,

        source_posted_at       TEXT,
        first_seen_at          TEXT NOT NULL,
        last_seen_at           TEXT NOT NULL,
        closed_at              TEXT,
        closed_reason          TEXT,

        rules_score            INTEGER,
        rules_score_reasons    TEXT,

        llm_score              INTEGER,
        llm_score_reasons      TEXT,
        llm_scored_at          TEXT,
        llm_scored_brief_hash  TEXT,

        status                 TEXT NOT NULL DEFAULT 'new',
        status_changed_at      TEXT NOT NULL,
        application_id         TEXT REFERENCES applications(id),

        raw_payload            TEXT,

        UNIQUE (source, source_job_id)
      );

      CREATE INDEX idx_job_leads_source_lookup ON job_leads(source, source_job_id);
      CREATE INDEX idx_job_leads_fingerprint   ON job_leads(content_fingerprint);
      CREATE INDEX idx_job_leads_active_recent ON job_leads(status, first_seen_at DESC) WHERE closed_at IS NULL;
      CREATE INDEX idx_job_leads_rules_score   ON job_leads(rules_score DESC) WHERE status = 'new' AND closed_at IS NULL;
      CREATE INDEX idx_job_leads_company       ON job_leads(company);
    `);
  },
};
