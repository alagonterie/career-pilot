/**
 * The dev data reset's table list (§24.41/§24.48) — the job_leads children
 * (§24.191 tailored_resumes, §24.200 job_lead_tombstones) are listed ahead of
 * job_leads, and a wipe leaves no orphan rows behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';

import { APP_DATA_TABLES, PIPELINE_DATA_TABLES, wipeTables } from './app-data-reset.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('PIPELINE_DATA_TABLES', () => {
  it('lists job_lead_tombstones and tailored_resumes ahead of job_leads', () => {
    const list = [...PIPELINE_DATA_TABLES] as string[];
    const leads = list.indexOf('job_leads');
    expect(leads).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('job_lead_tombstones')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('job_lead_tombstones')).toBeLessThan(leads);
    expect(list.indexOf('tailored_resumes')).toBeLessThan(leads);
  });

  it('a wipe clears leads with their children and leaves no orphan rows (FKs restored on)', () => {
    const db = getDb();
    const now = '2026-11-16T00:00:00.000Z';
    db.prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, content_fingerprint, title, company,
                              first_seen_at, last_seen_at, status, status_changed_at)
       VALUES ('l1', 'greenhouse', 'g1', 'https://x/1', 'fp', 'Engineer', 'Acme', ?, ?, 'new', ?)`,
    ).run(now, now, now);
    db.prepare(`INSERT INTO tailored_resumes (id, lead_id, created_at, status) VALUES ('t1', 'l1', ?, 'ready')`).run(
      now,
    );
    db.prepare(
      `INSERT INTO job_lead_tombstones (id, source, source_job_id, reason, match, created_at)
       VALUES ('tb1', 'google_jobs', 'gj-1', 'link:aggregator', 'id', ?)`,
    ).run(now);

    const cleared = wipeTables(db, APP_DATA_TABLES);
    expect(cleared).toMatchObject({ job_leads: 1, tailored_resumes: 1, job_lead_tombstones: 1 });

    for (const t of ['job_leads', 'tailored_resumes', 'job_lead_tombstones']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('lists lead_source_runs ahead of job_leads and never lists ats_watchlist or search_quota_usage (§24.200)', () => {
    const list = [...APP_DATA_TABLES] as string[];
    expect(list.indexOf('lead_source_runs')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('lead_source_runs')).toBeLessThan(list.indexOf('job_leads'));
    expect(list).not.toContain('ats_watchlist');
    expect(list).not.toContain('search_quota_usage');
  });

  it('lists agent_actions ahead of job_leads (§24.202)', () => {
    const list = [...APP_DATA_TABLES] as string[];
    expect(list.indexOf('agent_actions')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('agent_actions')).toBeLessThan(list.indexOf('job_leads'));
  });

  it('a wipe clears agent_actions with the pool and leaves no orphan rows', () => {
    const db = getDb();
    const now = '2026-11-16T00:00:00.000Z';
    db.prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, content_fingerprint, title, company,
                              first_seen_at, last_seen_at, status, status_changed_at)
       VALUES ('l1', 'greenhouse', 'g1', 'https://x/1', 'fp', 'Engineer', 'Acme', ?, ?, 'new', ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO agent_actions (id, kind, lead_id, status, created_at) VALUES ('a1', 'research_company', 'l1', 'done', ?)`,
    ).run(now);
    const cleared = wipeTables(db, APP_DATA_TABLES);
    expect(cleared).toMatchObject({ agent_actions: 1, job_leads: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_actions').get() as { n: number }).n).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('a wipe clears sourcing runs but PRESERVES the watchlist and the search quota counter', () => {
    const db = getDb();
    const now = '2026-11-16T00:00:00.000Z';
    db.prepare(
      `INSERT INTO ats_watchlist (ats, token, company, tier, origin, state, created_at, updated_at)
       VALUES ('ashby', 'acme', 'Acme', 'A', 'owner', 'paused', ?, ?)`,
    ).run(now, now);
    db.prepare(`INSERT INTO lead_source_runs (id, started_at, ok) VALUES ('run-1', ?, 1)`).run(now);
    db.prepare(`INSERT INTO search_quota_usage (day, pages, updated_at) VALUES ('2026-11-16', 3, ?)`).run(now);

    const cleared = wipeTables(db, APP_DATA_TABLES);
    expect(cleared).toMatchObject({ lead_source_runs: 1 });
    expect(cleared).not.toHaveProperty('ats_watchlist');

    expect((db.prepare('SELECT COUNT(*) AS n FROM lead_source_runs').get() as { n: number }).n).toBe(0);
    expect(db.prepare("SELECT state, origin FROM ats_watchlist WHERE token = 'acme'").get()).toEqual({
      state: 'paused',
      origin: 'owner',
    });
    expect((db.prepare('SELECT pages FROM search_quota_usage').get() as { pages: number }).pages).toBe(3);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
