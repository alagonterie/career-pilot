/**
 * `fetch_source` applies the same early insert guard as `stash_job_payloads`
 * (STRATEGY.md §24.201 D1): a tombstoned or title-blocklisted board posting is
 * counted by reason and NOT cached, so the subagent never sees it and a later
 * `record_job_lead` for it is NOT_IN_CACHE.
 *
 * The board adapter and the seed targets are mocked — no network.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import type { JobLeadPayload } from './scrape-jobs/types.js';

const boardPostings: JobLeadPayload[] = [];

vi.mock('./scrape-jobs/targets.js', () => ({
  filterTargets: () => [{ source: 'greenhouse', token: 'acme', company: 'Acme', priority: 'A' }],
}));
vi.mock('./scrape-jobs/sources.js', () => ({
  getAdapter: () => ({
    source: 'greenhouse',
    list: async () => ({ ok: true, absent: false, postings: boardPostings.map((p) => ({ ...p })) }),
  }),
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import * as payloadCache from './scrape-jobs/payload-cache.js';
import type { Session } from '../../types.js';

import { handleFetchSource, handleRecordJobLead } from './job-lead-actions.js';
import { writeTombstone } from './lead-guard.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-fetch-guard-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'test-session-fetch-guard',
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
  runMigrations(initTestDb());
  payloadCache.clear();
  boardPostings.length = 0;
  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Frame = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

async function call(
  handler: (c: Record<string, unknown>, s: Session, d: Database.Database) => Promise<void>,
  requestId: string,
  payload: Record<string, unknown>,
): Promise<Frame> {
  await handler({ requestId, payload }, FAKE_SESSION, inDb);
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return (JSON.parse(row.content) as { frame: Frame }).frame;
}

function posting(over: Partial<JobLeadPayload> = {}): JobLeadPayload {
  return {
    source: 'greenhouse',
    source_board_token: 'acme',
    source_job_id: 'gh-1',
    source_url: 'https://boards.greenhouse.io/acme/jobs/1',
    apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location_raw: 'Remote, US',
    workplace_type: 'remote',
    description_text: 'Build distributed systems in Go and Postgres for a payments platform team.',
    source_posted_at: '2026-11-15T00:00:00.000Z',
    ...over,
  };
}

describe('fetch_source early guard (§24.201 D1)', () => {
  it('does not cache or summarize a tombstoned or blocklisted posting, and reports rejected counts', async () => {
    boardPostings.push(
      posting(),
      posting({ source_job_id: 'gh-tomb', source_url: 'https://boards.greenhouse.io/acme/jobs/2' }),
      posting({ source_job_id: 'gh-block', title: 'Sales Engineer' }),
    );
    writeTombstone(getDb(), {
      source: 'greenhouse',
      source_job_id: 'gh-tomb',
      content_fingerprint: null,
      company: 'Acme',
      title: 'Senior Backend Engineer',
      reason: 'not_interested:location',
      match: 'id',
    });
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES ('lead_title_blocklist', '["sales engineer"]', ?)`,
      )
      .run(new Date().toISOString());

    const out = await call(handleFetchSource, 'f1', { company: 'Acme' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.data.summaries as Array<{ source_job_id: string }>).map((s) => s.source_job_id)).toEqual(['gh-1']);
    expect(out.data.postings_total).toBe(1);
    expect(out.data.rejected).toEqual({ tombstone: 1, title_blocklist: 1 });
    expect(out.data.rejected_total).toBe(2);

    expect(payloadCache.get('greenhouse', 'gh-tomb')).toBeUndefined();
    const rec = await call(handleRecordJobLead, 'r1', { source: 'greenhouse', source_job_id: 'gh-tomb' });
    expect(rec.ok).toBe(false);
    if (rec.ok) return;
    expect(rec.error.code).toBe('NOT_IN_CACHE');
  });

  it('reports an empty rejected map when nothing is refused', async () => {
    boardPostings.push(posting());
    const out = await call(handleFetchSource, 'f2', { company: 'Acme' });
    if (!out.ok) throw new Error('fetch_source failed');
    expect(out.data).toMatchObject({ postings_total: 1, rejected: {}, rejected_total: 0 });
  });
});
