/**
 * Migration 121 — funnel curator (Gmail + Calendar).
 *
 * Four tables backing the funnel-curator subagent: classified inbox events
 * linked to applications/leads, the per-run materialized read-model that
 * downstream surfaces (daily-briefing, on-demand persona, killer-match
 * suppression) consume, and the per-account/per-calendar sync-state used
 * for incremental delta fetches (Gmail historyId; Calendar syncToken).
 *
 * Schema reference: STRATEGY.md §24.9.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration121: Migration = {
  version: 121,
  name: 'career-pilot-funnel-curator',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE email_events (
        gmail_msg_id          TEXT PRIMARY KEY,
        thread_id             TEXT NOT NULL,
        classification        TEXT NOT NULL,
        confidence            REAL NOT NULL,
        linked_job_lead_id    TEXT REFERENCES job_leads(id),
        linked_application_id TEXT REFERENCES applications(id),
        from_addr             TEXT,
        subject               TEXT,
        received_at           TEXT,
        evidence_excerpt      TEXT,
        classified_at         TEXT NOT NULL,
        classified_by_run_id  TEXT NOT NULL
      );

      CREATE INDEX idx_email_events_lead        ON email_events(linked_job_lead_id);
      CREATE INDEX idx_email_events_application ON email_events(linked_application_id);
      CREATE INDEX idx_email_events_thread      ON email_events(thread_id);
      CREATE INDEX idx_email_events_classified  ON email_events(classified_at DESC);

      CREATE TABLE funnel_curator_output (
        id                    TEXT PRIMARY KEY,
        run_at                TEXT NOT NULL,
        gmail_history_id      TEXT,
        calendar_sync_tokens  TEXT,
        narratives_json       TEXT NOT NULL,
        attention_json        TEXT NOT NULL,
        suggestions_json      TEXT NOT NULL,
        cheap_out             INTEGER NOT NULL DEFAULT 0,
        cost_usd              REAL
      );

      CREATE INDEX idx_funnel_curator_output_run_at ON funnel_curator_output(run_at DESC);

      CREATE TABLE gmail_sync_state (
        account_id            TEXT PRIMARY KEY,
        history_id            TEXT NOT NULL,
        last_full_sync_at     TEXT NOT NULL
      );

      CREATE TABLE calendar_sync_state (
        account_id            TEXT NOT NULL,
        calendar_id           TEXT NOT NULL,
        sync_token            TEXT NOT NULL,
        last_full_sync_at     TEXT NOT NULL,
        PRIMARY KEY (account_id, calendar_id)
      );
    `);
  },
};
