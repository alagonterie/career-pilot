/**
 * Migration 145 — job_leads.apply_link_kind (STRATEGY.md §24.190).
 *
 * How direct a lead's apply link is: 'company' (the employer's own site), 'ats'
 * (a known applicant-tracking system), 'aggregator' (only a reposter's link was
 * available), or NULL for rows written before this existed.
 *
 * It carries TWO facts, because they have one cause. An aggregator-only link is
 * both (a) an application the owner may not be able to reach without creating an
 * account somewhere, and (b) a listing whose COMPANY attribution is unverified —
 * Google's `company_name` is least trustworthy exactly on a reposted listing
 * (observed: a lead filed under one company whose description body named a
 * different one). Rather than guess the real company from the body — the kind of
 * inference that produces confident wrong answers — we record how the lead
 * reached us and let the surface caveat it.
 *
 * Backfillable with no API spend: `raw_payload.apply_options` is already stored
 * on every google_jobs lead, so `scripts/backfill-apply-links.ts` re-derives both
 * the link and the kind for existing rows without re-scraping.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration145: Migration = {
  version: 145,
  name: 'career-pilot-job-leads-apply-link-kind',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE job_leads ADD COLUMN apply_link_kind TEXT;`);
  },
};
