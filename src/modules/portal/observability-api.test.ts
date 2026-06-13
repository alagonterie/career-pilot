/**
 * Integration tests for the /api/observability + /api/dev/health endpoints
 * (STRATEGY.md §24.69). Driven over `fetch` against an ephemeral server.
 *
 * /api/observability is public + aggregate-only (the §9 boundary); /api/dev/health
 * is owner-only (404 unless `ENVIRONMENT==='dev'`) and runs `skipLiveProbes`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { startPortalApi, stopPortalApi } from './api.js';
import { _resetObservabilityCache } from './observability.js';

let base: string;
const savedEnv = process.env.ENVIRONMENT;
const savedSeam = process.env.PORTAL_MOCK_STATE_SEAM;

beforeEach(async () => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  db.pragma('foreign_keys = OFF');
  _resetObservabilityCache();
  const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await stopPortalApi();
  closeDb();
  _resetObservabilityCache();
  if (savedEnv === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = savedEnv;
  if (savedSeam === undefined) delete process.env.PORTAL_MOCK_STATE_SEAM;
  else process.env.PORTAL_MOCK_STATE_SEAM = savedSeam;
});

function seedRow(provider: string, ok: boolean, cls = 'host', cost: number | null = 1000): void {
  getDb()
    .prepare(
      `INSERT INTO request_telemetry
         (id, ts, provider, surface, traffic_class, cost_microusd, latency_ms, status_code, ok, error)
       VALUES (?, ?, ?, 'x', ?, ?, 120, ?, ?, ?)`,
    )
    .run(
      `rt-${Math.random().toString(36).slice(2, 10)}`,
      new Date().toISOString(),
      provider,
      cls,
      cost,
      ok ? 200 : 401,
      ok ? 1 : 0,
      ok ? null : 'invalid_grant secret@example.com',
    );
}

describe('GET /api/observability', () => {
  it('returns spend_by_class, providers, and session_topology', async () => {
    seedRow('portkey', true, 'host', 1000);
    seedRow('gmail', false, 'host', null);

    const body = (await (await fetch(`${base}/api/observability`)).json()) as {
      spend_by_class: Record<string, { microusd_24h: number; buckets: number[] }>;
      providers: Array<{ provider: string; status: string; requests_24h: number }>;
      session_topology: { chat: number; ops: number; sandbox: number };
    };

    expect(Object.keys(body.spend_by_class).sort()).toEqual(['chat', 'host', 'ops', 'sandbox']);
    expect(body.spend_by_class.host.buckets).toHaveLength(24);
    expect(body.spend_by_class.host.microusd_24h).toBe(1000);
    expect(body.providers.find((p) => p.provider === 'portkey')?.status).toBe('healthy');
    expect(body.providers.find((p) => p.provider === 'gmail')?.status).toBe('down');
    expect(body.session_topology).toEqual({ chat: 0, ops: 0, sandbox: 0 });
  });

  it('never leaks row-level sensitive fields (the §9 guarantee)', async () => {
    seedRow('gmail', false, 'host', null);
    const text = await (await fetch(`${base}/api/observability`)).text();
    for (const forbidden of ['"error"', '"session_id"', '"trace_id"', '"details_json"', 'invalid_grant', 'secret@']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('honors the empty forced-state seam (dev/E2E only)', async () => {
    process.env.PORTAL_MOCK_STATE_SEAM = '1';
    seedRow('portkey', true);
    const body = (await (await fetch(`${base}/api/observability?__state=empty`)).json()) as {
      spend_by_class: Record<string, { microusd_24h: number }>;
      providers: unknown[];
      session_topology: { chat: number };
    };
    expect(body.spend_by_class.host.microusd_24h).toBe(0);
    expect(body.providers).toEqual([]);
    expect(body.session_topology.chat).toBe(0);
  });
});

describe('GET /api/dev/health', () => {
  it('404s on a non-dev stack', async () => {
    delete process.env.ENVIRONMENT;
    const res = await fetch(`${base}/api/dev/health`);
    expect(res.status).toBe(404);
  });

  it('returns a HealthReport on the dev stack', async () => {
    process.env.ENVIRONMENT = 'dev';
    const res = await fetch(`${base}/api/dev/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ranAt: string; findings: Array<{ id: string; severity: string }> };
    expect(typeof body.ranAt).toBe('string');
    expect(Array.isArray(body.findings)).toBe(true);
  });
});
