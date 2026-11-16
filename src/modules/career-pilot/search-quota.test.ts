/**
 * The search supplement's spend gate (STRATEGY.md §24.200 D8) and its run
 * summary (§24.201 D6): reservations refused past the daily page cap and past
 * the period quota since the anchor day; the host action's answer shapes; the
 * stash recording refusals by reason and by originating site.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { handleStashJobPayloads } from './job-lead-actions.js';
import * as payloadCache from './scrape-jobs/payload-cache.js';
import {
  handleReserveSearchQuota,
  quotaPeriodStart,
  readLastSearch,
  readSearchQuota,
  reserveSearchPages,
} from './search-quota.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-search-quota-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');
const SESSION = { id: 's', agent_group_id: 'g' } as unknown as Session;
let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
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

function setPref(key: string, value: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, String(value), new Date().toISOString());
}

function usage(day: string, pages: number): void {
  getDb()
    .prepare('INSERT INTO search_quota_usage (day, pages, updated_at) VALUES (?, ?, ?)')
    .run(day, pages, new Date().toISOString());
}

describe('quotaPeriodStart', () => {
  it('is the most recent anchor day on or before today (UTC)', () => {
    expect(quotaPeriodStart(new Date('2026-11-16T12:00:00Z'), 1)).toBe('2026-11-01');
    expect(quotaPeriodStart(new Date('2026-11-16T12:00:00Z'), 16)).toBe('2026-11-16');
    expect(quotaPeriodStart(new Date('2026-11-16T12:00:00Z'), 20)).toBe('2026-10-20');
    expect(quotaPeriodStart(new Date('2026-01-05T00:00:00Z'), 10)).toBe('2025-12-10');
    expect(quotaPeriodStart(new Date('2026-03-31T00:00:00Z'), 31)).toBe('2026-03-28'); // clamped to 28
  });
});

describe('reserveSearchPages', () => {
  const now = new Date('2026-11-16T12:00:00Z');

  it('grants and counts pages until the daily cap, then refuses without counting', () => {
    setPref('search_daily_page_cap', 3);
    setPref('search_monthly_quota', 100);
    expect(reserveSearchPages(getDb(), 2, now)).toMatchObject({ granted: true, used_today: 2 });
    expect(reserveSearchPages(getDb(), 1, now)).toMatchObject({ granted: true, used_today: 3 });
    const refused = reserveSearchPages(getDb(), 1, now);
    expect(refused).toMatchObject({ granted: false, reason: 'daily_cap', used_today: 3, daily_cap: 3 });
    expect(refused.granted === false && refused.message).toMatch(/daily search budget spent/);
    expect(readSearchQuota(getDb(), now).used_today).toBe(3);
    // The next day is a fresh daily budget.
    expect(reserveSearchPages(getDb(), 1, new Date('2026-11-17T00:00:01Z'))).toMatchObject({ granted: true });
  });

  it('refuses past the monthly quota counted since the anchor day (days before it do not count)', () => {
    setPref('search_daily_page_cap', 50);
    setPref('search_monthly_quota', 10);
    setPref('search_quota_period_anchor_day', 5);
    usage('2026-11-04', 40); // previous period
    usage('2026-11-05', 6);
    usage('2026-11-15', 3);
    expect(readSearchQuota(getDb(), now)).toMatchObject({ used_period: 9, period_start: '2026-11-05' });
    expect(reserveSearchPages(getDb(), 1, now)).toMatchObject({ granted: true, used_period: 10 });
    expect(reserveSearchPages(getDb(), 1, now)).toMatchObject({
      granted: false,
      reason: 'monthly_quota',
      used_period: 10,
      monthly_quota: 10,
    });
  });

  it('a daily cap of 0 turns search off', () => {
    setPref('search_daily_page_cap', 0);
    expect(reserveSearchPages(getDb(), 1, now)).toMatchObject({ granted: false, reason: 'daily_cap' });
  });
});

type Frame = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

async function call(
  handler: (c: Record<string, unknown>, s: Session, d: Database.Database) => Promise<void>,
  payload: Record<string, unknown>,
): Promise<Frame> {
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  await handler({ requestId, payload }, SESSION, inDb);
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as {
    content: string;
  };
  return (JSON.parse(row.content) as { frame: Frame }).frame;
}

describe('career_pilot.reserve_search_quota', () => {
  it('answers granted, then a refusal as a normal (non-error) frame', async () => {
    setPref('search_daily_page_cap', 1);
    expect(await call(handleReserveSearchQuota, { pages: 1 })).toMatchObject({ ok: true, data: { granted: true } });
    expect(await call(handleReserveSearchQuota, { pages: 1 })).toMatchObject({
      ok: true,
      data: { granted: false, reason: 'daily_cap' },
    });
  });

  it('refuses bad page counts as BAD_ARGS', async () => {
    for (const pages of [0, -1, 1.5, 'two', 11]) {
      expect(await call(handleReserveSearchQuota, { pages })).toMatchObject({
        ok: false,
        error: { code: 'BAD_ARGS' },
      });
    }
  });
});

describe('the stash records the last search (by reason and by site)', () => {
  function hit(id: string, kind: 'aggregator' | 'ats', via: string) {
    return {
      source: 'google_jobs',
      source_board_token: null,
      source_job_id: id,
      source_url: `https://example.com/jobs/${id}`,
      apply_url: `https://example.com/jobs/${id}`,
      apply_link_kind: kind,
      title: `Backend Engineer ${id}`,
      company: 'Acme',
      description_text: `Posting ${id}`,
      raw_payload: { via },
    };
  }

  it('writes a search run row with rejected counts and rejected_by_site from raw_payload.via', async () => {
    const frame = await call(handleStashJobPayloads, {
      payloads: [
        hit('a', 'aggregator', 'via RepostBoard'),
        hit('b', 'aggregator', 'via RepostBoard'),
        hit('c', 'aggregator', 'OtherBoard'),
        hit('d', 'ats', 'via Acme Careers'),
      ],
    });
    expect(frame).toMatchObject({ ok: true, data: { stashed: 1, rejected: { link_kind: 3 } } });
    const last = readLastSearch(getDb());
    expect(last).toMatchObject({
      rejected: { link_kind: 3 },
      rejected_by_site: { RepostBoard: 2, OtherBoard: 1 },
    });
    expect(last?.at).toBeTruthy();
  });
});
