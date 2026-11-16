/**
 * scripts/purge-aggregator-leads.ts (STRATEGY.md §24.201 D3) — against a real
 * migrated schema with foreign keys ON, so a delete that would throw on the
 * email_events FK (or silently cascade a tailored résumé) is caught here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

import { purgeAggregatorLeads } from './purge-aggregator-leads.js';

const NOW = '2026-11-16T00:00:00.000Z';

const AGG_PAYLOAD = JSON.stringify({
  apply_options: [{ title: 'Reposter', link: 'https://reposter.example/job/1' }],
  share_link: 'https://www.google.com/search?ibp=htl;jobs',
});
const DIRECT_PAYLOAD = JSON.stringify({
  apply_options: [
    { title: 'Reposter', link: 'https://reposter.example/job/2' },
    { title: 'Greenhouse', link: 'https://boards.greenhouse.io/acme/jobs/2' },
  ],
});

function seed(over: {
  id: string;
  source?: string;
  status?: string;
  apply_link_kind?: string | null;
  application_id?: string | null;
  raw_payload?: string | null;
  source_url?: string;
}): void {
  const d = {
    source: 'google_jobs',
    status: 'new',
    apply_link_kind: 'aggregator' as string | null,
    application_id: null as string | null,
    raw_payload: AGG_PAYLOAD as string | null,
    source_url: 'https://reposter.example/job/1',
    ...over,
  };
  getDb()
    .prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, apply_url, apply_link_kind, content_fingerprint,
                              title, company, first_seen_at, last_seen_at, status, status_changed_at,
                              application_id, raw_payload)
       VALUES (@id, @source, 'sj-' || @id, @source_url, @source_url, @apply_link_kind, 'abcdef0123456789',
               'Senior Engineer', 'Acme', '${NOW}', '${NOW}', @status, '${NOW}', @application_id, @raw_payload)`,
    )
    .run(d);
}

function ids(): string[] {
  return (getDb().prepare('SELECT id FROM job_leads ORDER BY id').all() as { id: string }[]).map((r) => r.id);
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('purgeAggregatorLeads', () => {
  function seedFixture(): void {
    const db = getDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    seed({ id: 'agg-plain' }); // deleted
    seed({ id: 'unknown-legacy', apply_link_kind: null, raw_payload: null, source_url: '' }); // no link at all → re-derives 'unknown' → deleted
    seed({ id: 'agg-but-direct', raw_payload: DIRECT_PAYLOAD }); // re-derives to 'ats' → kept
    seed({ id: 'manual', source: 'manual', apply_link_kind: null, raw_payload: null }); // never examined
    seed({ id: 'board', source: 'greenhouse', apply_link_kind: 'ats', raw_payload: null }); // never examined
    seed({ id: 'queued', status: 'queued' });
    seed({ id: 'reviewed', status: 'reviewed' });

    db.prepare(
      `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
       VALUES ('app-1', 'Acme', 'a fintech company', 'Senior Engineer', 'applied', '${NOW}', '${NOW}')`,
    ).run();
    seed({ id: 'with-app', status: 'applied', application_id: 'app-1' });

    seed({ id: 'with-resume' });
    db.prepare(
      `INSERT INTO tailored_resumes (id, lead_id, created_at, status) VALUES ('tr-1', 'with-resume', ?, 'ready')`,
    ).run(NOW);

    seed({ id: 'with-email' });
    db.prepare(
      `INSERT INTO email_events (gmail_msg_id, thread_id, classification, confidence, linked_job_lead_id,
                                 classified_at, classified_by_run_id)
       VALUES ('m1', 't1', 'recruiter_outreach', 0.9, 'with-email', ?, 'run-1')`,
    ).run(NOW);
  }

  it('is a dry run by default: reports, writes nothing', () => {
    seedFixture();
    const before = ids();
    const r = purgeAggregatorLeads(getDb(), { apply: false });
    expect(r.apply).toBe(false);
    expect(r.examined).toBe(8); // only the google_jobs rows (manual + board are never examined)
    expect(r.deleted).toBe(2);
    expect(ids()).toEqual(before);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM job_lead_tombstones').get() as { n: number }).n).toBe(0);
    // re-derived kinds are not written on a dry run either
    const k = getDb().prepare(`SELECT apply_link_kind FROM job_leads WHERE id = 'agg-but-direct'`).get() as {
      apply_link_kind: string;
    };
    expect(k.apply_link_kind).toBe('aggregator');
  });

  it('--apply deletes only rejected-kind search leads, skips by reason, and writes id-only tombstones', () => {
    seedFixture();
    const r = purgeAggregatorLeads(getDb(), { apply: true });

    expect(r.deleted).toBe(2);
    expect(r.skipped_by_reason).toEqual({
      application: 1,
      tailored_resume: 1,
      email_link: 1,
      owner_status: 2,
    });
    expect(r.skipped).toBe(5);
    expect(r.rejected_kind).toBe(7);

    expect(ids()).toEqual([
      'agg-but-direct',
      'board',
      'manual',
      'queued',
      'reviewed',
      'with-app',
      'with-email',
      'with-resume',
    ]);
    // The manual (NULL-kind) lead is untouched, kind still NULL.
    const manual = getDb().prepare(`SELECT apply_link_kind FROM job_leads WHERE id = 'manual'`).get() as {
      apply_link_kind: string | null;
    };
    expect(manual.apply_link_kind).toBeNull();
    // Re-derivation ran first and was written: the row with a direct option is now 'ats'.
    const kept = getDb()
      .prepare(`SELECT apply_link_kind, apply_url FROM job_leads WHERE id = 'agg-but-direct'`)
      .get() as {
      apply_link_kind: string;
      apply_url: string;
    };
    expect(kept).toEqual({ apply_link_kind: 'ats', apply_url: 'https://boards.greenhouse.io/acme/jobs/2' });
    // The tailored résumé was not cascaded away.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM tailored_resumes').get() as { n: number }).n).toBe(1);

    const tombs = getDb()
      .prepare('SELECT source_job_id, reason, match FROM job_lead_tombstones ORDER BY source_job_id')
      .all();
    expect(tombs).toEqual([
      { source_job_id: 'sj-agg-plain', reason: 'link:aggregator', match: 'id' },
      { source_job_id: 'sj-unknown-legacy', reason: 'link:unknown', match: 'id' },
    ]);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });

  it('is idempotent: a second --apply deletes nothing more', () => {
    seedFixture();
    purgeAggregatorLeads(getDb(), { apply: true });
    const again = purgeAggregatorLeads(getDb(), { apply: true });
    expect(again.deleted).toBe(0);
    expect(again.rederived_changed).toBe(0);
  });

  it('skips (and reports) a lead an admin agent action is still working on (§24.203 D2)', () => {
    seed({ id: 'agg-busy' });
    seed({ id: 'agg-done' });
    seed({ id: 'agg-free' });
    const ins = getDb().prepare(
      `INSERT INTO agent_actions (id, kind, lead_id, company, title, status, created_at)
       VALUES (?, 'research_company', ?, 'Acme', 'Senior Engineer', ?, '${NOW}')`,
    );
    ins.run('act-1', 'agg-busy', 'running');
    ins.run('act-2', 'agg-done', 'done');
    const r = purgeAggregatorLeads(getDb(), { apply: true });
    expect(r.skipped_by_reason).toEqual({ action_in_flight: 1 });
    expect(r.deleted).toBe(2);
    expect(ids()).toEqual(['agg-busy']);
    // the finished action outlived its lead
    expect(getDb().prepare("SELECT lead_id, company FROM agent_actions WHERE id = 'act-2'").get()).toEqual({
      lead_id: null,
      company: 'Acme',
    });
  });
});
