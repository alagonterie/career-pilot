/**
 * Integration tests for the Sub-milestone 5.3 telemetry + architecture
 * endpoints (STRATEGY.md §24.17). Driven over `fetch` against an ephemeral
 * server. Portkey is forced into bypass (no network) and Docker is treated as
 * optional, so the tests are deterministic on any dev machine.
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
  process.env.PORTKEY_BYPASS = 'true';
  _resetTelemetryCache();
  const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await stopPortalApi();
  closeDb();
  delete process.env.PORTKEY_BYPASS;
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
  it('reports Portkey unavailable under bypass + correct local aggregates', async () => {
    seedSimRun('s1');
    seedSimRun('s2');
    seedAudit(1, nowIso());
    seedAudit(2, nowIso());
    seedAudit(3, daysAgoIso(2)); // outside 24h

    const body = (await (await fetch(`${base}/api/telemetry`)).json()) as {
      portkey: { available: boolean; reason?: string };
      local: {
        simulator_runs_total: number;
        activity_events_total: number;
        activity_events_24h: number;
      };
    };

    expect(body.portkey.available).toBe(false);
    expect(body.portkey.reason).toBe('bypass');
    expect(body.local.simulator_runs_total).toBe(2);
    expect(body.local.activity_events_total).toBe(3);
    expect(body.local.activity_events_24h).toBe(2);
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
