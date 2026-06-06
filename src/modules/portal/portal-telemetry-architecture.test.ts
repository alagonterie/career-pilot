/**
 * Integration tests for the /api/telemetry + /api/architecture endpoints
 * (STRATEGY.md §24.17, telemetry source reworked to local per-turn data in
 * §24.47). Driven over `fetch` against an ephemeral server. Telemetry is sourced
 * entirely from the local turn rows (no Portkey network call); Docker is treated
 * as optional, so the tests are deterministic on any dev machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { startPortalApi, stopPortalApi } from './api.js';
import { _resetTelemetryCache } from './portkey-analytics.js';

let base: string;

beforeEach(async () => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  db.pragma('foreign_keys = OFF'); // isolate leaf-row seeds (sessions FK → agent_groups)
  _resetTelemetryCache();
  const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await stopPortalApi();
  closeDb();
  _resetTelemetryCache();
});

function seedSimRun(id: string): void {
  getDb().prepare(`INSERT INTO simulator_runs (id, ts) VALUES (?, '2026-05-29T00:00:00Z')`).run(id);
}

function seedAudit(seq: number, ts: string): void {
  getDb()
    .prepare(
      `INSERT INTO public_audit_trail (id, seq, ts, category, summary)
       VALUES (?, ?, ?, 'funnel', 'x')`,
    )
    .run(`pat-${seq}`, seq, ts);
}

function seedTurn(seq: number, ts: string, costCents: number, model?: string, details?: string): void {
  getDb()
    .prepare(
      `INSERT INTO public_audit_trail (id, seq, ts, category, cost_cents, model_used, details_json, summary)
       VALUES (?, ?, ?, 'turn', ?, ?, ?, 'turn complete')`,
    )
    .run(`pat-turn-${seq}`, seq, ts, costCents, model ?? null, details ?? null);
}

/** A turn details_json carrying duration + model_usage (the §24.47 derived lanes). */
function turnDetails(durationMs: number, cacheRead: number, input: number): string {
  return JSON.stringify({
    duration_api_ms: durationMs,
    model_usage: { 'claude-haiku-4-5': { input, output: 100, cache_read: cacheRead, cache_creation: 0 } },
  });
}

function seedSession(id: string, status: string, containerStatus: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, 'g1', NULL, NULL, NULL, ?, ?, NULL, '2026-05-29T00:00:00Z')`,
    )
    .run(id, status, containerStatus);
}

const nowIso = (): string => new Date().toISOString();
const daysAgoIso = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

// ── /api/telemetry ──────────────────────────────────────────────────────────

describe('GET /api/telemetry', () => {
  it('returns local aggregates only — no Portkey field, no network call (§24.47)', async () => {
    seedSimRun('s1');
    seedSimRun('s2');
    seedAudit(1, nowIso());
    seedAudit(2, nowIso());
    seedAudit(3, daysAgoIso(2)); // outside 24h

    const body = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      portkey?: unknown;
      local: {
        simulator_runs_total: number;
        activity_events_total: number;
        activity_events_24h: number;
      };
    };

    expect(body.portkey).toBeUndefined();
    expect(body.local.simulator_runs_total).toBe(2);
    expect(body.local.activity_events_total).toBe(3);
    expect(body.local.activity_events_24h).toBe(2);
  });

  it('derives cache-hit rate, turn p50, and top model from the turn rows (§24.47)', async () => {
    // Two turns: 90% cache (900 read / 1000 prompt) and 50% (100/200) → aggregate
    // 1000/1200 ≈ 0.833; durations 1000 & 3000 → p50 = 1000 (nearest-rank).
    seedTurn(20, nowIso(), 6, 'claude-haiku-4-5', turnDetails(1000, 900, 100));
    seedTurn(21, nowIso(), 4, 'claude-haiku-4-5', turnDetails(3000, 100, 100));

    const body = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      local: { cache_hit_rate: number; turn_p50_ms: number; turn_p95_ms: number; top_model: string; turns_24h: number };
    };
    expect(body.local.cache_hit_rate).toBeCloseTo(1000 / 1200, 5);
    expect(body.local.turn_p50_ms).toBe(1000);
    expect(body.local.turn_p95_ms).toBe(3000);
    expect(body.local.top_model).toBe('claude-haiku-4-5');
    expect(body.local.turns_24h).toBe(2);
  });

  it('leaves the derived lanes null when no turn details have been captured (§24.47)', async () => {
    seedAudit(1, nowIso()); // a funnel row — no turn telemetry
    const body = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      local: {
        cache_hit_rate: number | null;
        turn_p50_ms: number | null;
        top_model: string | null;
        turns_total: number;
      };
    };
    expect(body.local.turns_total).toBe(0);
    expect(body.local.cache_hit_rate).toBeNull();
    expect(body.local.turn_p50_ms).toBeNull();
    expect(body.local.top_model).toBeNull();
  });

  it('sums per-turn cost into the local aggregate (§24.34)', async () => {
    seedTurn(10, nowIso(), 6);
    seedTurn(11, nowIso(), 4);
    seedTurn(12, daysAgoIso(2), 9); // outside the 24h window
    seedAudit(13, nowIso()); // a funnel row contributes nothing to turn cost

    const body = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      local: { turns_total: number; turn_cost_cents_total: number; turn_cost_cents_24h: number };
    };
    expect(body.local.turns_total).toBe(3);
    expect(body.local.turn_cost_cents_total).toBe(19); // 6 + 4 + 9
    expect(body.local.turn_cost_cents_24h).toBe(10); // 6 + 4 (the 9 is > 24h)
  });

  it('caches the response for the configured window', async () => {
    seedSimRun('s1');
    const first = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      local: { simulator_runs_total: number };
    };
    expect(first.local.simulator_runs_total).toBe(1);

    // Add another run; within the 30s cache the response must not change.
    seedSimRun('s2');
    const cached = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      local: { simulator_runs_total: number };
    };
    expect(cached.local.simulator_runs_total).toBe(1);

    // After dropping the cache it recomputes.
    _resetTelemetryCache();
    const fresh = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      local: { simulator_runs_total: number };
    };
    expect(fresh.local.simulator_runs_total).toBe(2);
  });
});

// ── /api/architecture ───────────────────────────────────────────────────────

describe('GET /api/architecture', () => {
  it('returns session counts from the DB + a Docker-agnostic container block', async () => {
    seedSession('a', 'active', 'running');
    seedSession('b', 'active', 'idle');
    seedSession('c', 'inactive', 'stopped');

    const body = (await (await fetch(`${base}/api/architecture`)).json()) as {
      sessions: { active: number; running: number };
      containers: {
        running: number | null;
        capacity_max: number;
        memory_mb_each: number;
        runtime: string;
      };
      backend: string;
    };

    expect(body.sessions.active).toBe(2);
    expect(body.sessions.running).toBe(2);
    expect(body.backend).toBe('online');
    expect(body.containers.capacity_max).toBe(4);
    expect(body.containers.memory_mb_each).toBe(512);
    // Docker may or may not be present in the test env — both shapes are valid.
    expect(body.containers.running === null || typeof body.containers.running === 'number').toBe(true);
    expect(body.containers.runtime).toBe(body.containers.running === null ? 'down' : 'up');
  });
});
