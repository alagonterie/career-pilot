/**
 * Board adapters (STRATEGY.md §24.200 D6): Greenhouse dates from
 * `first_published`, the Ashby adapter (incl. the hybrid case — `isRemote` is
 * never read), the `{ok, absent, postings}` result, explicit gzip, and the
 * response cache's entry cap. Fixture-driven; `fetch` is stubbed — no network.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';

import {
  _clearCache,
  _testing,
  ashbyAdapter,
  getAdapter,
  greenhouseAdapter,
  leverAdapter,
  toUtcIso,
} from './sources.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function stubFetch(body: string, status = 200, headers: Record<string, string> = {}) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status, headers }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function setPref(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value, new Date().toISOString());
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  _clearCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _clearCache();
  closeDb();
});

describe('Greenhouse', () => {
  it('stores first_published as source_posted_at, not the last edit (falls back to updated_at)', async () => {
    stubFetch(fixture('greenhouse-board.json'));
    const res = await greenhouseAdapter.list('acme');
    expect(res).toMatchObject({ ok: true, absent: false });
    const [edited, noFirst] = res.postings;
    // Canonical UTC: the board's local offset is folded in (10:00-05:00 → 15:00Z).
    expect(edited.source_posted_at).toBe('2025-03-02T15:00:00.000Z');
    // The edit date is kept for reference, never as the posting date.
    expect(edited.raw_payload).toMatchObject({ updated_at: '2026-11-15T08:30:00-05:00' });
    expect(noFirst.source_posted_at).toBe('2026-11-14T13:30:00.000Z');
    expect(edited).toMatchObject({ source: 'greenhouse', source_board_token: 'acme', source_job_id: '7001001' });
  });
});

describe('toUtcIso (stored timestamps are canonical UTC)', () => {
  it('folds an offset into Z, keeps Z, accepts epoch ms, and nulls garbage', () => {
    expect(toUtcIso('2026-11-16T05:00:00-05:00')).toBe('2026-11-16T10:00:00.000Z');
    expect(toUtcIso('2026-11-16T10:00:00.000+00:00')).toBe('2026-11-16T10:00:00.000Z');
    expect(toUtcIso(Date.parse('2026-11-16T10:00:00Z'))).toBe('2026-11-16T10:00:00.000Z');
    expect(toUtcIso('not a date')).toBeNull();
    expect(toUtcIso(null)).toBeNull();
    expect(toUtcIso('')).toBeNull();
  });
});

describe('Ashby', () => {
  it('normalizes a remote posting: dates, links, comp, equity, employment, secondary locations', async () => {
    const fetchFn = stubFetch(fixture('ashby-board.json'));
    const res = await ashbyAdapter.list('acme');
    expect(res.ok).toBe(true);
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true',
    );
    const remote = res.postings.find((p) => p.source_job_id.endsWith('0001'))!;
    expect(remote).toMatchObject({
      source: 'ashby',
      source_board_token: 'acme',
      title: 'Senior Software Engineer, Platform',
      source_url: 'https://jobs.ashbyhq.com/acme/0b6c2f0e-1111-4a8e-9a8f-000000000001',
      apply_url: 'https://jobs.ashbyhq.com/acme/0b6c2f0e-1111-4a8e-9a8f-000000000001/application',
      location_raw: 'Remote - United States',
      workplace_type: 'remote',
      is_remote: true,
      remote_region: 'US',
      employment_type: 'full-time',
      comp_min_usd: 180000,
      comp_max_usd: 220000,
      comp_currency: 'USD',
      comp_period: 'year',
      has_equity: true,
      source_posted_at: '2026-11-10T17:04:12.000Z',
      description_text: 'Build the platform & its tooling.',
      description_html: null,
    });
    expect(remote.raw_payload).toMatchObject({ secondary_locations: ['Remote - Canada'], team: 'Platform' });
  });

  it('reads a HYBRID posting from workplaceType even though isRemote is true', async () => {
    stubFetch(fixture('ashby-board.json'));
    const res = await ashbyAdapter.list('acme');
    const hybrid = res.postings.find((p) => p.source_job_id.endsWith('0002'))!;
    expect(hybrid.workplace_type).toBe('hybrid');
    expect(hybrid.is_remote).toBe(false);
    expect(hybrid.remote_region).toBeNull();
    const onsite = res.postings.find((p) => p.source_job_id.endsWith('0003'))!;
    expect(onsite).toMatchObject({ workplace_type: 'onsite', is_remote: false, employment_type: 'contract' });
    expect(onsite.comp_min_usd).toBeNull();
  });

  it('skips unlisted postings', async () => {
    stubFetch(fixture('ashby-board.json'));
    const res = await ashbyAdapter.list('acme');
    expect(res.postings.map((p) => p.source_job_id)).not.toContain('0b6c2f0e-4444-4a8e-9a8f-000000000004');
    expect(res.postings).toHaveLength(3);
  });

  it('is registered as an adapter', () => {
    expect(getAdapter('ashby')).toBe(ashbyAdapter);
  });
});

describe('list result shape (§24.200 D6b)', () => {
  it('a 404 board is absent, not ok', async () => {
    stubFetch('gone', 404);
    expect(await leverAdapter.list('gone-board')).toMatchObject({ ok: false, absent: true, postings: [] });
  });

  it('a 429 is a failure — neither ok nor absent', async () => {
    stubFetch('slow down', 429);
    expect(await greenhouseAdapter.list('busy')).toMatchObject({ ok: false, absent: false, postings: [], status: 429 });
  });

  it('a malformed body is a failure', async () => {
    stubFetch('<html>not json</html>');
    const res = await ashbyAdapter.list('broken');
    expect(res.ok).toBe(false);
    expect(res.absent).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('an empty board is ok with zero postings', async () => {
    stubFetch(JSON.stringify({ jobs: [] }));
    expect(await greenhouseAdapter.list('empty')).toMatchObject({ ok: true, absent: false, postings: [] });
  });

  it('asks for gzip explicitly', async () => {
    const fetchFn = stubFetch(JSON.stringify([]));
    await leverAdapter.list('acme');
    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Accept-Encoding']).toBe('gzip');
  });
});

describe('response cache cap (§24.200 D6f)', () => {
  it('evicts the least recently used board past ats_response_cache_max_entries', async () => {
    setPref('ats_response_cache_max_entries', '2');
    const fetchFn = stubFetch(JSON.stringify({ jobs: [] }));

    await greenhouseAdapter.list('a');
    await greenhouseAdapter.list('b');
    await greenhouseAdapter.list('a'); // cache hit — refreshes a's recency
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await greenhouseAdapter.list('c'); // over the cap: b (least recently used) goes
    expect(_testing.cacheSize()).toBe(2);
    expect(_testing.cacheHas('greenhouse', 'a')).toBe(true);
    expect(_testing.cacheHas('greenhouse', 'b')).toBe(false);
    expect(_testing.cacheHas('greenhouse', 'c')).toBe(true);

    await greenhouseAdapter.list('b'); // evicted → refetched
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});
