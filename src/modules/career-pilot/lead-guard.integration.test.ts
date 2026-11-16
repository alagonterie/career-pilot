/**
 * Integration tests for the shared pre-insert lead guard (STRATEGY.md §24.201
 * D1 + D2, §24.202 D4) across both of its callers: `stash_job_payloads` (early —
 * a refused payload is never cached) and `record_job_lead` / `upsertJobLead`
 * (the writer — re-checks, answers a refusal with a non-error recorded:false).
 *
 * Harness mirrors serpapi-stash.integration.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import * as payloadCache from './scrape-jobs/payload-cache.js';
import type { JobLeadPayload } from './scrape-jobs/types.js';
import type { Session } from '../../types.js';

import { handleRecordJobLead, handleStashJobPayloads, upsertJobLead } from './job-lead-actions.js';
import { computeFingerprint } from './lead-fingerprint.js';
import { ZERO_FINGERPRINT, checkLeadGuard, writeTombstone } from './lead-guard.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-guard-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'test-session-guard',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-11-16T00:00:00Z',
};

let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  payloadCache.clear();
  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Frame<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function readFrame<T = Record<string, unknown>>(requestId: string): Frame<T> {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return (JSON.parse(row.content) as { frame: Frame<T> }).frame;
}

async function call(
  handler: (c: Record<string, unknown>, s: Session, d: Database.Database) => Promise<void>,
  requestId: string,
  payload: Record<string, unknown>,
): Promise<Frame<Record<string, unknown>>> {
  await handler({ requestId, payload }, FAKE_SESSION, inDb);
  return readFrame(requestId);
}

function setPref(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value, new Date().toISOString());
}

function hit(over: Partial<JobLeadPayload> = {}): JobLeadPayload {
  return {
    source: 'google_jobs',
    source_board_token: null,
    source_job_id: 'gj-1',
    source_url: 'https://jobs.example.com/acme/1',
    apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
    apply_link_kind: 'ats',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location_raw: 'Remote, US',
    workplace_type: 'remote',
    description_text: 'Build distributed systems in Go and Postgres for a payments platform team.',
    source_posted_at: '2026-11-15T00:00:00.000Z',
    ...over,
  };
}

function leadCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM job_leads').get() as { n: number }).n;
}

describe('stash + record: link-kind gate (§24.201 D1)', () => {
  it('an aggregator payload is reported rejected, not cached, and record_job_lead returns NOT_IN_CACHE', async () => {
    const agg = hit({
      source_job_id: 'gj-agg',
      apply_link_kind: 'aggregator',
      apply_url: 'https://reposter.example/x',
    });
    const stash = await call(handleStashJobPayloads, 's1', { payloads: [agg, hit()] });
    expect(stash.ok).toBe(true);
    if (!stash.ok) return;
    expect(stash.data.stashed).toBe(1);
    expect(stash.data.rejected).toEqual({ link_kind: 1 });
    expect(stash.data.rejected_total).toBe(1);
    expect((stash.data.summaries as Array<{ source_job_id: string }>).map((s) => s.source_job_id)).toEqual(['gj-1']);

    const rec = await call(handleRecordJobLead, 'r1', { source: 'google_jobs', source_job_id: 'gj-agg' });
    expect(rec.ok).toBe(false);
    if (rec.ok) return;
    expect(rec.error.code).toBe('NOT_IN_CACHE');
    expect(leadCount()).toBe(0);
  });

  it('summaries carry apply_link_kind, resolved as the writer stores it', async () => {
    const stash = await call(handleStashJobPayloads, 's2', { payloads: [hit()] });
    if (!stash.ok) throw new Error('stash failed');
    expect((stash.data.summaries as Array<{ apply_link_kind: string }>)[0].apply_link_kind).toBe('ats');
  });

  it('a payload with a missing kind is treated exactly as the insert treats it (search → unknown)', async () => {
    const noKind = hit({ source_job_id: 'gj-nokind', apply_link_kind: undefined });
    // Default knob rejects 'unknown' → the missing kind resolves to it and is refused.
    const s1 = await call(handleStashJobPayloads, 's3', { payloads: [noKind] });
    if (!s1.ok) throw new Error('stash failed');
    expect(s1.data.rejected).toEqual({ link_kind: 1 });

    // Narrow the knob to aggregator only: the same payload is now accepted, and
    // the row stores the SAME resolution ('unknown') the guard used.
    setPref('lead_reject_link_kinds', '["aggregator"]');
    const s2 = await call(handleStashJobPayloads, 's4', { payloads: [noKind] });
    if (!s2.ok) throw new Error('stash failed');
    expect(s2.data.stashed).toBe(1);
    expect((s2.data.summaries as Array<{ apply_link_kind: string }>)[0].apply_link_kind).toBe('unknown');
    const rec = await call(handleRecordJobLead, 'r2', { source: 'google_jobs', source_job_id: 'gj-nokind' });
    expect(rec.ok).toBe(true);
    const row = getDb().prepare(`SELECT apply_link_kind FROM job_leads WHERE source_job_id = 'gj-nokind'`).get() as {
      apply_link_kind: string;
    };
    expect(row.apply_link_kind).toBe('unknown');
  });

  it('a board-sourced payload with no kind is direct (ats) and never link-rejected', () => {
    const board = hit({ source: 'greenhouse', source_job_id: 'gh-1', apply_link_kind: undefined });
    expect(checkLeadGuard(getDb(), board)).toEqual({ ok: true });
  });
});

describe('tombstones (§24.201 D2)', () => {
  it('an id-tombstoned posting is refused; the same posting re-found with a direct link is accepted', () => {
    const db = getDb();
    const agg = hit({ source_job_id: 'gj-x', apply_link_kind: 'aggregator' });
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-x',
      content_fingerprint: computeFingerprint(agg),
      company: 'Acme',
      title: agg.title,
      reason: 'link:aggregator',
      match: 'id',
    });
    // Even with the link knob widened so only the tombstone can refuse it:
    setPref('lead_reject_link_kinds', '[]');
    expect(checkLeadGuard(db, agg)).toMatchObject({ ok: false, reason: 'tombstone' });

    // Same (source, source_job_id), now with a direct link → accepted and stored.
    const direct = hit({ source_job_id: 'gj-x', apply_link_kind: 'company', apply_url: 'https://acme.com/jobs/1' });
    const res = upsertJobLead(db, direct);
    expect(res.recorded).toBe(true);
    // And the same job found on the employer's own board (different source) too.
    expect(upsertJobLead(db, hit({ source: 'greenhouse', source_job_id: 'gh-x' })).recorded).toBe(true);
  });

  it('an owner-intent id tombstone refuses the same id regardless of link', () => {
    const db = getDb();
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-1',
      content_fingerprint: null,
      company: 'Acme',
      title: 'Senior Backend Engineer',
      reason: 'not_interested:location',
      match: 'id',
    });
    expect(upsertJobLead(db, hit())).toMatchObject({ recorded: false, reason: 'tombstone' });
  });

  it('a location-reason tombstone does not refuse a same-description posting in another location', () => {
    const db = getDb();
    const nyc = hit({ source_job_id: 'gj-nyc', location_raw: 'New York, NY' });
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-nyc',
      content_fingerprint: computeFingerprint(nyc),
      company: 'Acme',
      title: nyc.title,
      reason: 'not_interested:location',
      match: 'id',
    });
    const sf = hit({ source_job_id: 'gj-sf', location_raw: 'San Francisco, CA' });
    expect(upsertJobLead(db, sf).recorded).toBe(true);
    // Even an IDENTICAL payload under a new id passes an id-only tombstone.
    expect(upsertJobLead(db, { ...nyc, source_job_id: 'gj-nyc-2' }).recorded).toBe(true);
  });

  it('a fingerprint tombstone refuses an identical payload under a new id from the same company only', () => {
    const db = getDb();
    const original = hit({ source_job_id: 'gj-orig' });
    const fp = computeFingerprint(original);
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-orig',
      content_fingerprint: fp,
      company: 'Acme Inc.',
      title: original.title,
      reason: 'not_interested:role',
      match: 'fingerprint',
    });
    // Identical content, new id, same (normalized) company → refused.
    expect(upsertJobLead(db, { ...original, source_job_id: 'gj-repost' })).toMatchObject({
      recorded: false,
      reason: 'tombstone',
    });
    // The same fingerprint attributed to a DIFFERENT company's tombstone does not reach Acme.
    db.prepare('DELETE FROM job_lead_tombstones').run();
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-other',
      content_fingerprint: fp,
      company: 'Initech',
      title: original.title,
      reason: 'not_interested:role',
      match: 'fingerprint',
    });
    expect(upsertJobLead(db, { ...original, source_job_id: 'gj-repost' }).recorded).toBe(true);
  });

  it('a near fingerprint is refused only once lead_tombstone_hamming_max allows it', () => {
    const db = getDb();
    const original = hit({ source_job_id: 'gj-orig' });
    const fp = computeFingerprint(original);
    // Flip one bit of the stored fingerprint.
    const flipped = ((parseInt(fp[15], 16) ^ 1) & 0xf).toString(16);
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-orig',
      content_fingerprint: fp.slice(0, 15) + flipped,
      company: 'Acme',
      title: original.title,
      reason: 'deleted',
      match: 'fingerprint',
    });
    const repost = { ...original, source_job_id: 'gj-repost' };
    expect(checkLeadGuard(db, repost).ok).toBe(true); // default 0 = exact only
    setPref('lead_tombstone_hamming_max', '1');
    expect(checkLeadGuard(db, repost)).toMatchObject({ ok: false, reason: 'tombstone' });
  });

  it('a zero fingerprint never matches', () => {
    const db = getDb();
    // Only 1-char tokens → no usable signal → the all-zero fingerprint.
    const empty = hit({ source_job_id: 'gj-z1', title: 'X', company: 'Q', location_raw: null, description_text: null });
    expect(computeFingerprint(empty)).toBe(ZERO_FINGERPRINT);
    writeTombstone(db, {
      source: 'google_jobs',
      source_job_id: 'gj-z0',
      content_fingerprint: ZERO_FINGERPRINT,
      company: 'Q',
      title: 'X',
      reason: 'deleted',
      match: 'fingerprint',
    });
    expect(checkLeadGuard(db, empty)).toEqual({ ok: true });
  });

  it('record re-checks: a tombstone written after the stash yields a non-error recorded:false', async () => {
    const stash = await call(handleStashJobPayloads, 's5', { payloads: [hit()] });
    expect(stash.ok).toBe(true);
    writeTombstone(getDb(), {
      source: 'google_jobs',
      source_job_id: 'gj-1',
      content_fingerprint: null,
      company: 'Acme',
      title: 'Senior Backend Engineer',
      reason: 'not_interested:other',
      match: 'id',
    });
    const rec = await call(handleRecordJobLead, 'r5', { source: 'google_jobs', source_job_id: 'gj-1' });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.data).toMatchObject({ recorded: false, reason: 'tombstone' });
    expect(leadCount()).toBe(0);
  });
});

describe('a refused re-sighting of a lead still in the pool', () => {
  const OLD = '2026-10-01T00:00:00.000Z';
  function lead(sjid: string): { last_seen_at: string; apply_link_kind: string; apply_url: string } {
    return getDb()
      .prepare('SELECT last_seen_at, apply_link_kind, apply_url FROM job_leads WHERE source_job_id = ?')
      .get(sjid) as { last_seen_at: string; apply_link_kind: string; apply_url: string };
  }

  it('advances last_seen_at (stash and writer) but never downgrades the stored row to the refused content', async () => {
    const db = getDb();
    expect(upsertJobLead(db, hit()).recorded).toBe(true);
    db.prepare('UPDATE job_leads SET last_seen_at = ?').run(OLD);

    // The index now ranks an aggregator link first for the same posting.
    const reranked = hit({ apply_link_kind: 'aggregator', apply_url: 'https://reposter.example/x' });
    const stash = await call(handleStashJobPayloads, 's7', { payloads: [reranked] });
    if (!stash.ok) throw new Error('stash failed');
    expect(stash.data.rejected).toEqual({ link_kind: 1 });
    expect(lead('gj-1').last_seen_at > OLD).toBe(true);

    db.prepare('UPDATE job_leads SET last_seen_at = ?').run(OLD);
    expect(upsertJobLead(db, reranked)).toMatchObject({ recorded: false, reason: 'link_kind' });
    const row = lead('gj-1');
    expect(row.last_seen_at > OLD).toBe(true);
    expect(row).toMatchObject({ apply_link_kind: 'ats', apply_url: 'https://boards.greenhouse.io/acme/jobs/1' });
  });

  it('does not touch a closed lead, and inserts nothing for an unknown one', () => {
    const db = getDb();
    expect(upsertJobLead(db, hit()).recorded).toBe(true);
    db.prepare(`UPDATE job_leads SET last_seen_at = ?, closed_at = ?, status = 'archived'`).run(OLD, OLD);
    expect(upsertJobLead(db, hit({ apply_link_kind: 'aggregator' })).recorded).toBe(false);
    expect(lead('gj-1').last_seen_at).toBe(OLD);
    expect(upsertJobLead(db, hit({ source_job_id: 'gj-new', apply_link_kind: 'aggregator' })).recorded).toBe(false);
    expect(leadCount()).toBe(1);
  });
});

describe('owner title blocklist (§24.202 D4)', () => {
  it('refuses a case-insensitive whole-title match, not a substring', async () => {
    setPref('lead_title_blocklist', '["senior backend engineer"]');
    const stash = await call(handleStashJobPayloads, 's6', {
      payloads: [hit(), hit({ source_job_id: 'gj-2', title: 'Senior Backend Engineer II' })],
    });
    if (!stash.ok) throw new Error('stash failed');
    expect(stash.data.rejected).toEqual({ title_blocklist: 1 });
    expect((stash.data.summaries as Array<{ source_job_id: string }>).map((s) => s.source_job_id)).toEqual(['gj-2']);
    // The writer honours it for every caller, board sources included.
    expect(
      upsertJobLead(getDb(), hit({ source: 'lever', source_job_id: 'lv-1', title: 'SENIOR BACKEND ENGINEER' })),
    ).toMatchObject({ recorded: false, reason: 'title_blocklist' });
  });
});
