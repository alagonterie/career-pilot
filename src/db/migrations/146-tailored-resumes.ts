/**
 * Migration 146 — tailored_resumes (STRATEGY.md §24.191).
 *
 * A résumé tailored to ONE discovered lead, generated on demand from `/admin`
 * and rendered to a PDF the owner sends with a real application. The stored
 * `profile_json` is the guardrail-VALIDATED `WorkProfile` (post
 * `validateTailoredResume`), never the model's raw emission — so anything this
 * table can render has already been re-anchored to the master résumé.
 *
 * `ON DELETE CASCADE` is load-bearing, not housekeeping: purging a lead must not
 * leave behind a résumé naming that employer. FKs are enforced on the real
 * connection (`initDb`/`initTestDb` both set `foreign_keys = ON`) and
 * `applyAdminLeadsWrite`'s `bulk_delete` is the only `DELETE FROM job_leads`
 * callsite, so the cascade covers the whole purge path. The one place it can't
 * reach is the dev-reset `wipeTables`, which runs with FKs OFF by design — that
 * list names this table explicitly instead.
 *
 * Archiving a lead deliberately does NOT delete: `bulk_set_status → 'archived'`
 * is a soft close, so the résumé survives and returns intact if un-archived.
 *
 * Rows accumulate per lead rather than replacing — a regenerate ("emphasize the
 * platform work") keeps the prior version, and the newest is what the panel
 * shows.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration146: Migration = {
  version: 146,
  name: 'career-pilot-tailored-resumes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE tailored_resumes (
        id            TEXT PRIMARY KEY,
        lead_id       TEXT NOT NULL REFERENCES job_leads(id) ON DELETE CASCADE,

        created_at    TEXT NOT NULL,
        completed_at  TEXT,

        -- 'pending' doubles as the generate lock (one in-flight run per lead);
        -- terminal states are 'ready' and 'failed'.
        status        TEXT NOT NULL DEFAULT 'pending',

        -- The inputs, persisted so a result is reproducible and auditable: the
        -- JD actually used (the owner may paste the real posting over the stored
        -- description) and the free-text emphasis note.
        jd_used       TEXT,
        notes         TEXT,

        -- The guardrail-validated WorkProfile. NULL until 'ready'.
        profile_json  TEXT,

        -- Whether the bio was genuinely tailored or floored back to the master
        -- ('tailored' | 'fallback_stub' | 'fallback_unverified_number'). Shown in
        -- the panel, not merely logged: on a résumé going to a named employer
        -- this is the difference between tailored and "master, reordered".
        bio_outcome   TEXT,

        model         TEXT,
        cost_cents    INTEGER,
        error         TEXT,

        -- The §24.177 attribution slug baked into the PDF footer link, so a
        -- click-through from a real submission attributes to this application.
        source_slug   TEXT
      );

      CREATE INDEX idx_tailored_resumes_lead ON tailored_resumes(lead_id, created_at DESC);
    `);
  },
};
