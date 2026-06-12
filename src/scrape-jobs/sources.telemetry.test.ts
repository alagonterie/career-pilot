/**
 * Board-adapter telemetry tests (STRATEGY.md §24.68): every real board fetch
 * records one request_telemetry row — 2xx ok, non-2xx failure with status,
 * network throw failure with NULL status — and in-process cache hits record
 * nothing. The adapters' fail-soft contract (return []) is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { greenhouseAdapter, leverAdapter } from './sources.js';

interface Row {
  provider: string;
  surface: string;
  traffic_class: string;
  ok: number;
  status_code: number | null;
}

function rows(): Row[] {
  return getDb().prepare('SELECT * FROM request_telemetry').all() as Row[];
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
});

// Each test uses a unique board token — the module-level response cache
// persists across tests in this file.
let n = 0;
function freshToken(): string {
  return `tel-test-${process.pid}-${++n}`;
}

describe('board-adapter telemetry', () => {
  it('records an ok row for a 200 list fetch — and nothing for the cache hit after it', async () => {
    const token = freshToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })),
    );
    await greenhouseAdapter.list(token);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      provider: 'greenhouse',
      surface: 'scrape-board',
      traffic_class: 'host',
      ok: 1,
      status_code: 200,
    });

    await greenhouseAdapter.list(token); // in-process cache hit — no fetch, no row
    expect(rows()).toHaveLength(1);
  });

  it('records a failure row with the status on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 })),
    );
    const out = await leverAdapter.list(freshToken());
    expect(out).toEqual([]); // fail-soft contract unchanged
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ provider: 'lever', ok: 0, status_code: 404 });
  });

  it('records a failure row with a NULL status on a network throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ETIMEDOUT');
      }),
    );
    const out = await greenhouseAdapter.list(freshToken());
    expect(out).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ provider: 'greenhouse', ok: 0, status_code: null });
  });
});
