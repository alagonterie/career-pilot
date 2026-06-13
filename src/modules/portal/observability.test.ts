/**
 * Tests for the /api/observability assembler (STRATEGY.md §24.69).
 *
 * Covers: hourly spend bucketing (zero-filled, per class), per-provider 24h
 * stats (error rate, last-success age, p50, derived status via the D7
 * thresholds), session-topology classification (§24.67 split), the bare-DB
 * floor, the 30s cache, and — the §9 guarantee — that the served payload
 * carries no row-level sensitive fields.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { OPS_THREAD_ID } from '../career-pilot/ops-session.js';

import {
  _resetObservabilityCache,
  computeObservability,
  emptyObservability,
  getObservability,
} from './observability.js';

const NOW = Date.parse('2026-06-12T18:00:00.000Z');

/** Insert a telemetry row at `ageSec` seconds before NOW. */
function insert(opts: {
  provider: string;
  surface?: string;
  cls?: string;
  ok?: boolean;
  ageSec: number;
  cost?: number | null;
  latency?: number | null;
  status?: number | null;
  error?: string | null;
  sessionId?: string | null;
  /** Anchor the timestamp here instead of the fixed NOW — used by the cache test,
   * which calls the uncached getObservability() (it windows around real Date.now()). */
  base?: number;
}): void {
  const ts = new Date((opts.base ?? NOW) - opts.ageSec * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO request_telemetry
         (id, ts, provider, surface, traffic_class, session_id, cost_microusd, latency_ms, status_code, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `rt-${Math.random().toString(36).slice(2, 10)}`,
      ts,
      opts.provider,
      opts.surface ?? 'x',
      opts.cls ?? 'host',
      opts.sessionId ?? null,
      opts.cost ?? null,
      opts.latency ?? 0,
      opts.status ?? null,
      opts.ok === false ? 0 : 1,
      opts.error ?? null,
    );
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  _resetObservabilityCache();
});

afterEach(() => {
  closeDb();
});

describe('spend_by_class', () => {
  it('buckets cost into 24 zero-filled hourly lanes per class', () => {
    // host: $0.001 (1000 µ) 30 min ago → newest bucket (23)
    insert({ provider: 'portkey', cls: 'host', cost: 1000, ageSec: 30 * 60 });
    // host: 500 µ ~23h ago → oldest bucket (0)
    insert({ provider: 'portkey', cls: 'host', cost: 500, ageSec: 23 * 3600 + 1800 });
    // chat: 200 µ 2h ago
    insert({ provider: 'portkey', cls: 'chat', cost: 200, ageSec: 2 * 3600 });

    const obs = computeObservability(NOW);
    const host = obs.spend_by_class.host;
    expect(host.buckets).toHaveLength(24);
    expect(host.microusd_24h).toBe(1500);
    expect(host.buckets[23]).toBe(1000); // most recent hour
    expect(host.buckets[0]).toBe(500); // oldest hour in window
    expect(obs.spend_by_class.chat.microusd_24h).toBe(200);
    // Untouched classes are present and zeroed.
    expect(obs.spend_by_class.ops.microusd_24h).toBe(0);
    expect(obs.spend_by_class.sandbox.buckets.every((b) => b === 0)).toBe(true);
  });

  it('treats NULL cost as 0 and excludes rows older than 24h', () => {
    insert({ provider: 'gmail', cls: 'host', cost: null, ageSec: 60 }); // no cost
    insert({ provider: 'portkey', cls: 'host', cost: 9999, ageSec: 25 * 3600 }); // outside window
    const obs = computeObservability(NOW);
    expect(obs.spend_by_class.host.microusd_24h).toBe(0);
  });
});

describe('providers', () => {
  it('computes counts, error rate, last-success age, p50, and status', () => {
    // portkey: 3 ok + 1 fail; latencies 100/200/300/400 → p50 = 200 (nearest-rank)
    insert({ provider: 'portkey', ok: true, latency: 100, ageSec: 4000 });
    insert({ provider: 'portkey', ok: true, latency: 200, ageSec: 3000 });
    insert({ provider: 'portkey', ok: true, latency: 300, ageSec: 120 }); // newest success 2min ago
    insert({ provider: 'portkey', ok: false, latency: 400, status: 500, ageSec: 60 });

    const obs = computeObservability(NOW);
    const p = obs.providers.find((x) => x.provider === 'portkey')!;
    expect(p.requests_24h).toBe(4);
    expect(p.errors_24h).toBe(1);
    expect(p.error_rate).toBeCloseTo(0.25, 5);
    expect(p.last_success_age_sec).toBe(120);
    expect(p.p50_ms).toBe(200);
    // error_rate 0.25 hits the default degraded threshold (>= 0.25).
    expect(p.status).toBe('degraded');
  });

  it('marks a provider down when every attempt failed', () => {
    insert({ provider: 'gmail', ok: false, status: 401, ageSec: 300 });
    insert({ provider: 'gmail', ok: false, status: 401, ageSec: 60 });
    const p = computeObservability(NOW).providers.find((x) => x.provider === 'gmail')!;
    expect(p.status).toBe('down');
    expect(p.last_success_age_sec).toBeNull();
  });

  it('marks a healthy provider when fresh and error-free', () => {
    insert({ provider: 'drive', ok: true, latency: 50, ageSec: 120 });
    const p = computeObservability(NOW).providers.find((x) => x.provider === 'drive')!;
    expect(p.status).toBe('healthy');
    expect(p.error_rate).toBe(0);
  });

  it('keeps a quiet-but-clean provider healthy (staleness is not a node-color factor)', () => {
    // ok, but 2h ago — a low-frequency provider. Quiet ≠ degraded; the public
    // node reads healthy, and staleness is the owner-facing stale-surface finding.
    insert({ provider: 'serpapi', ok: true, latency: 80, ageSec: 7200 });
    const p = computeObservability(NOW).providers.find((x) => x.provider === 'serpapi')!;
    expect(p.status).toBe('healthy');
    expect(p.last_success_age_sec).toBe(7200); // still reported (drives the modal fact)
  });
});

describe('session_topology', () => {
  function seed(): void {
    createAgentGroup({
      id: 'ag-owner',
      name: 'Career Pilot',
      folder: 'career-pilot',
      agent_provider: null,
      created_at: '2026-05-27T00:00:00Z',
    });
    createAgentGroup({
      id: 'ag-sandbox',
      name: 'Sandbox',
      folder: 'career-pilot-sandbox',
      agent_provider: null,
      created_at: '2026-05-27T00:00:00Z',
    });
    const base = (over: Partial<Session>): Session => ({
      id: over.id!,
      agent_group_id: over.agent_group_id!,
      messaging_group_id: null,
      thread_id: over.thread_id ?? null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-06-01T00:00:00Z',
      ...over,
    });
    createSession(base({ id: 's-ops', agent_group_id: 'ag-owner', thread_id: OPS_THREAD_ID }));
    createSession(base({ id: 's-chat', agent_group_id: 'ag-owner', thread_id: null }));
    createSession(base({ id: 's-sandbox', agent_group_id: 'ag-sandbox', thread_id: 'web-123' }));
  }

  it('classifies active sessions into chat/ops/sandbox', () => {
    seed();
    const topo = computeObservability(NOW).session_topology;
    expect(topo).toEqual({ chat: 1, ops: 1, sandbox: 1 });
  });

  it('is all-zero when there are no active sessions', () => {
    expect(computeObservability(NOW).session_topology).toEqual({ chat: 0, ops: 0, sandbox: 0 });
  });
});

describe('graceful floor + cache', () => {
  it('degrades spend/providers to empty when request_telemetry is absent', () => {
    getDb().exec('DROP TABLE request_telemetry');
    const obs = computeObservability(NOW);
    expect(obs.providers).toEqual([]);
    expect(obs.spend_by_class).toEqual(emptyObservability().spend_by_class);
  });

  it('caches the computed value for the configured window', async () => {
    // getObservability() is the uncached public fn — it windows around real
    // Date.now(), so anchor these rows to real now (not the fixed NOW).
    const realNow = Date.now();
    insert({ provider: 'portkey', cls: 'host', cost: 1000, ageSec: 60, base: realNow });
    const first = await getObservability();
    insert({ provider: 'portkey', cls: 'host', cost: 5000, ageSec: 30, base: realNow });
    const cached = await getObservability();
    expect(cached).toBe(first); // same object — served from cache
    _resetObservabilityCache();
    const fresh = await getObservability();
    expect(fresh.spend_by_class.host.microusd_24h).toBeGreaterThan(first.spend_by_class.host.microusd_24h);
  });
});

describe('§9 projection safety', () => {
  it('never exposes row-level sensitive fields in the served payload', () => {
    insert({
      provider: 'gmail',
      ok: false,
      status: 401,
      error: 'invalid_grant: recruiter@example.com token dead',
      sessionId: 'sess-secret-123',
      ageSec: 60,
    });
    const json = JSON.stringify(computeObservability(NOW));
    for (const forbidden of ['"error"', '"session_id"', '"sessionId"', '"trace_id"', '"details_json"']) {
      expect(json).not.toContain(forbidden);
    }
    // And the actual sensitive VALUES never leak either.
    expect(json).not.toContain('invalid_grant');
    expect(json).not.toContain('sess-secret-123');
  });
});
