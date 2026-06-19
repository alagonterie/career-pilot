/**
 * Integration tests for `handleStashJobPayloads` (§24.50) and its round-trip
 * with `handleRecordJobLead`.
 *
 * The container-side `search_jobs` tool fetches SerpApi, normalizes to
 * JobLeadPayload[], and forwards them to `stash_job_payloads`, which populates
 * the same 1h payload-cache that `fetch_source` uses. `record_job_lead` then
 * re-hydrates from that cache. These tests prove that hand-off + the
 * fabrication guard (NOT_IN_CACHE on an unstashed id). Mirrors the
 * `job-lead-actions.integration.test.ts` harness.
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

import { handleRecordJobLead, handleStashJobPayloads } from './job-lead-actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-stash-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'test-session-stash',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-06-08T00:00:00Z',
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

interface ResponseFrame<T = Record<string, unknown>> {
  type: string;
  requestId: string;
  frame: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}

function readResponse<T = Record<string, unknown>>(requestId: string): ResponseFrame<T> {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return JSON.parse(row.content) as ResponseFrame<T>;
}

function call(
  handler: (c: Record<string, unknown>, s: Session, d: Database.Database) => Promise<void>,
  requestId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return handler({ requestId, payload }, FAKE_SESSION, inDb);
}

const GJ_PAYLOAD: JobLeadPayload = {
  source: 'google_jobs',
  source_board_token: null,
  source_job_id: 'gj-acorns-123',
  source_url: 'https://jobs.ashbyhq.com/acorns/cf23e51e',
  apply_url: 'https://jobs.ashbyhq.com/acorns/cf23e51e?utm_source=google_jobs_apply',
  title: 'Senior Backend Engineer, AI Team',
  company: 'Acorns',
  company_domain: null,
  location_raw: 'Anywhere',
  is_remote: true,
  workplace_type: 'remote',
  remote_region: 'GLOBAL',
  employment_type: 'full-time',
  comp_min_usd: 180_000,
  comp_max_usd: 240_000,
  comp_currency: 'USD',
  comp_period: 'year',
  description_html: null,
  description_text: 'Build AI agents. Python, Go, AWS, Kubernetes, distributed systems.',
  source_posted_at: '2026-06-05T12:00:00.000Z',
  raw_payload: { via: 'Jobs' },
};

describe('handleStashJobPayloads', () => {
  it('stashes valid payloads and returns summaries; skips malformed entries', async () => {
    const invalid = { source: 'google_jobs', title: 'no id or url' }; // missing source_job_id + source_url
    await call(handleStashJobPayloads, 'r1', { payloads: [GJ_PAYLOAD, invalid] });

    const res = readResponse<{ summaries: Array<Record<string, unknown>>; stashed: number; skipped: number }>('r1');
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) return;
    expect(res.frame.data.stashed).toBe(1);
    expect(res.frame.data.skipped).toBe(1);
    expect(res.frame.data.summaries).toHaveLength(1);
    expect(res.frame.data.summaries[0].source).toBe('google_jobs');
    expect(res.frame.data.summaries[0].company).toBe('Acorns');
    expect(typeof res.frame.data.summaries[0].snippet).toBe('string');
  });

  it('rejects a non-array / empty payloads arg', async () => {
    await call(handleStashJobPayloads, 'r2', { payloads: [] });
    const res = readResponse('r2');
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) return;
    expect(res.frame.error.code).toBe('BAD_ARGS');
  });

  it('round-trips: a stashed payload records via record_job_lead with fingerprint + rules_score', async () => {
    await call(handleStashJobPayloads, 'r3', { payloads: [GJ_PAYLOAD] });
    expect(readResponse('r3').frame.ok).toBe(true);

    await call(handleRecordJobLead, 'r4', { source: 'google_jobs', source_job_id: 'gj-acorns-123' });
    const res = readResponse<{
      id: string;
      inserted_or_updated: string;
      rules_score: number;
      content_fingerprint: string;
    }>('r4');
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) return;
    expect(res.frame.data.inserted_or_updated).toBe('inserted'); // proves the stash populated the cache
    expect(typeof res.frame.data.rules_score).toBe('number');
    expect(res.frame.data.rules_score).toBeGreaterThanOrEqual(0);
    expect(res.frame.data.content_fingerprint).toMatch(/^[0-9a-f]+$/);

    const row = getDb().prepare('SELECT source, company FROM job_leads WHERE id = ?').get(res.frame.data.id) as
      | { source: string; company: string }
      | undefined;
    expect(row?.source).toBe('google_jobs');
    expect(row?.company).toBe('Acorns');
  });

  it('record_job_lead on an un-stashed id returns NOT_IN_CACHE (fabrication guard)', async () => {
    await call(handleRecordJobLead, 'r5', { source: 'google_jobs', source_job_id: 'never-stashed' });
    const res = readResponse('r5');
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) return;
    expect(res.frame.error.code).toBe('NOT_IN_CACHE');
  });
});
