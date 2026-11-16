/**
 * Migration 155 — agent_actions (STRATEGY.md §24.203 D2).
 *
 * One row per `/admin` button press that asks the owner agent to do something:
 * a lead action (research the company, draft outreach, build an interview kit)
 * or a *Run now* of a recurring series. The row is at once the lock (a queued or
 * running row for a lead blocks a second press on that lead), the queue entry
 * (`message_id` is the one-shot task the host wrote into the ops session) and the
 * result (`result_md` / `result_json`).
 *
 *   - `kind`    — research_company | draft_outreach | build_interview_kit | run_now
 *   - `series`  — run_now only: job_scrape | daily_briefing
 *   - `status`  — queued | running | done | failed | expired
 *   - `lead_id` — ON DELETE SET NULL, with `company` / `title` copied at enqueue
 *                 so a finished result outlives its lead.
 *   - `session_id` — the ops session the task went into (progress read window).
 *   - `owns_task` — 1 while this action alone owns `message_id`'s task; 0 once
 *                 the task is shared (a kit wake the status trigger deduped
 *                 onto, or one the action deduped onto) — expiry then never
 *                 cancels it.
 *
 * Cleared by the dev data reset (listed ahead of job_leads).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration155: Migration = {
  version: 155,
  name: 'career-pilot-agent-actions',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_actions (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        series         TEXT,
        lead_id        TEXT REFERENCES job_leads(id) ON DELETE SET NULL,
        company        TEXT,
        title          TEXT,
        application_id TEXT,
        round          TEXT,
        note           TEXT,
        status         TEXT NOT NULL DEFAULT 'queued',
        session_id     TEXT,
        message_id     TEXT,
        owns_task      INTEGER NOT NULL DEFAULT 1,
        result_md      TEXT,
        result_json    TEXT,
        error          TEXT,
        created_at     TEXT NOT NULL,
        started_at     TEXT,
        completed_at   TEXT
      );

      CREATE INDEX idx_agent_actions_lead ON agent_actions(lead_id, status);
      CREATE INDEX idx_agent_actions_status ON agent_actions(status);
      CREATE INDEX idx_agent_actions_created ON agent_actions(created_at);
    `);
  },
};
