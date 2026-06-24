/**
 * Unit tests for the Sub-milestone 5.5c run lifecycle (STRATEGY.md §24.21):
 * accumulation → finalize/persist → sweep, plus the results/recent reads.
 * Teardown is a guarded no-op here (no sandbox group/session seeded), which is
 * the point — finalize must not require a live runtime.
 *
 * The portal adapter is mocked so startSimulatorRun doesn't need a live host
 * and the module-load setSimulatorOutputSink() call is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

vi.mock('../../channels/portal/adapter.js', () => ({
  submitSimulatorRun: vi.fn(),
  setSimulatorOutputSink: vi.fn(),
  SANDBOX_PLATFORM_ID: 'sandbox',
}));

import {
  deleteSimulatorRun,
  finalizeSimulatorRun,
  getAdminSandboxStats,
  getAdminSimulatorRuns,
  getRecentSimulatorRuns,
  getSimulatorResult,
  recordSimulatorOutput,
  startSimulatorRun,
  sweepExpiredSimulatorRuns,
} from './simulator.js';

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  vi.clearAllMocks();
});

afterEach(() => closeDb());

function seedRun(
  id: string,
  opts: { company?: string; shareable?: number; expiresAt?: string | null; cost?: number; ts?: string },
): void {
  getDb()
    .prepare(
      `INSERT INTO simulator_runs (id, ts, visitor_company, visitor_role, total_cost_cents, shareable, expires_at)
       VALUES (?, ?, ?, 'SWE', ?, ?, ?)`,
    )
    .run(
      id,
      opts.ts ?? new Date().toISOString(),
      opts.company ?? 'Acme',
      opts.cost ?? null,
      opts.shareable ?? 1,
      opts.expiresAt ?? null,
    );
}

describe('run accumulation + finalize', () => {
  it('persists a row on the terminal result trace (cost, latency, output) — §24.21 Δ', () => {
    const { simulation_id: id } = startSimulatorRun({ company: 'Acme', role: 'Staff SWE', jd: 'Ship things' });
    expect(id).toBeDefined();

    recordSimulatorOutput(id!, 'trace', { t: 'subagent', subagent: 'research-company' });
    recordSimulatorOutput(id!, 'chat', { text: 'Tailored bullets…' });
    recordSimulatorOutput(id!, 'chat', { text: 'Done — outreach drafted.' });
    recordSimulatorOutput(id!, 'trace', { t: 'result', cost_usd: 0.041 });

    const row = getSimulatorResult(id!);
    expect(row).not.toBeNull();
    expect(row!.visitor_company).toBe('Acme');
    expect(row!.total_cost_cents).toBe(4); // round(0.041 * 100)
    expect(row!.jd_excerpt).toBe('Ship things');
    expect(row!.tailored_resume).toContain('Tailored bullets');
    expect(row!.tailored_resume).toContain('Done — outreach drafted.');
    expect(typeof row!.total_latency_ms).toBe('number');
    expect(row!.expires_at).not.toBeNull();
    // The dispatch trace persists for the share page (§24.31 Δ); the terminal
    // `result` event is captured into cost, not stored as a step.
    const trace = JSON.parse(row!.trace_json!) as Array<{ t: string; subagent?: string }>;
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ t: 'subagent', subagent: 'research-company' });
  });

  it('finalize is idempotent — a result/hard-wall race persists exactly once', () => {
    const { simulation_id: id } = startSimulatorRun({ company: 'Acme', role: 'SWE' });
    recordSimulatorOutput(id!, 'trace', { t: 'result', cost_usd: 0.01 });
    // Second finalize (e.g. the hard-wall firing after completion) is a no-op.
    finalizeSimulatorRun(id!, 'hard-wall');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM simulator_runs WHERE id = ?').get(id!) as { c: number })
      .c;
    expect(count).toBe(1);
  });

  it('a chat row arriving after finalize is a no-op (accumulator already claimed)', () => {
    const { simulation_id: id } = startSimulatorRun({ company: 'Acme', role: 'SWE' });
    recordSimulatorOutput(id!, 'trace', { t: 'result', cost_usd: 0.01 });
    recordSimulatorOutput(id!, 'chat', { text: 'late straggler' });
    expect(getSimulatorResult(id!)!.tailored_resume).toBeNull();
  });

  it('recordSimulatorOutput on an unknown/finalized run is a no-op (no throw)', () => {
    expect(() => recordSimulatorOutput('sb-nope', 'chat', { text: 'x' })).not.toThrow();
    expect(getSimulatorResult('sb-nope')).toBeNull();
  });
});

describe('getSimulatorResult', () => {
  it('returns null for an absent or expired run', () => {
    expect(getSimulatorResult('sb-missing')).toBeNull();
    seedRun('sb-old', { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(getSimulatorResult('sb-old')).toBeNull();
  });

  it('returns a live cached run', () => {
    seedRun('sb-live', { company: 'Globex', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(getSimulatorResult('sb-live')?.visitor_company).toBe('Globex');
  });
});

describe('sweepExpiredSimulatorRuns', () => {
  it('deletes only expired rows', () => {
    seedRun('sb-keep', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    seedRun('sb-gone', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const deleted = sweepExpiredSimulatorRuns();
    expect(deleted).toBe(1);
    expect(getSimulatorResult('sb-keep')).not.toBeNull();
    expect(getSimulatorResult('sb-gone')).toBeNull();
  });
});

describe('getRecentSimulatorRuns — metrics only, newest first, filtered (§24.162)', () => {
  it('returns shareable non-expired runs newest-first as metrics, with no visitor text or id', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    seedRun('sb-old', { company: 'A', cost: 11, ts: new Date(Date.now() - 60_000).toISOString(), expiresAt: future });
    seedRun('sb-new', { company: 'B', cost: 22, ts: new Date().toISOString(), expiresAt: future });
    seedRun('sb-hidden', { company: 'C', shareable: 0, expiresAt: future }); // opted out
    seedRun('sb-expired', { company: 'D', expiresAt: new Date(Date.now() - 1000).toISOString() }); // expired
    const recent = getRecentSimulatorRuns(10);
    // Only the two shareable, non-expired runs, newest first — identified by cost, not text.
    expect(recent.map((r) => r.total_cost_cents)).toEqual([22, 11]);
    // §24.162: no visitor free-text, no run id (no result-page key) on the public feed.
    for (const r of recent) {
      expect(r.visitor_company).toBeUndefined();
      expect(r.visitor_role).toBeUndefined();
      expect(r.id).toBeUndefined();
    }
  });
});

// §24.164: the owner-only Sandbox-runs read — the INVERSE of the public feed.
function seedAdminRun(
  id: string,
  o: {
    company?: string;
    role?: string;
    jd?: string;
    cost?: number;
    latency?: number;
    ip?: string | null;
    completed?: boolean;
    ts?: string;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO simulator_runs
         (id, ts, visitor_company, visitor_role, jd_excerpt, total_cost_cents, total_latency_ms,
          tailored_resume_json, shareable, client_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      o.ts ?? new Date().toISOString(),
      o.company ?? 'Acme',
      o.role ?? 'Staff SWE',
      o.jd ?? null,
      o.cost ?? null,
      o.latency ?? null,
      o.completed ? '{"x":1}' : null,
      o.ip ?? null,
    );
}

describe('getAdminSimulatorRuns — owner detail, no raw IP (§24.164)', () => {
  it('returns the visitor free-text + derives status, newest-first', () => {
    seedAdminRun('r-old', {
      company: 'Globex',
      jd: 'Ship',
      completed: true,
      ts: new Date(Date.now() - 60_000).toISOString(),
    });
    seedAdminRun('r-new', { company: 'Initech', completed: false, ts: new Date().toISOString() });
    const runs = getAdminSimulatorRuns(10);
    expect(runs.map((r) => r.id)).toEqual(['r-new', 'r-old']); // newest first
    const globex = runs.find((r) => r.id === 'r-old')!;
    expect(globex.visitor_company).toBe('Globex'); // owner sees the raw free-text (unlike the public feed)
    expect(globex.jd_excerpt).toBe('Ship');
    expect(globex.status).toBe('completed'); // has a tailored output
    expect(runs.find((r) => r.id === 'r-new')!.status).toBe('incomplete');
  });

  it('folds the client IP to a stable token and NEVER returns the raw address', () => {
    seedAdminRun('r-a', { ip: '203.0.113.7' });
    seedAdminRun('r-b', { ip: '203.0.113.7' }); // same source
    seedAdminRun('r-c', { ip: '198.51.100.4' });
    const runs = getAdminSimulatorRuns(10);
    const tok = Object.fromEntries(runs.map((r) => [r.id, r.ip_token]));
    expect(JSON.stringify(runs)).not.toContain('203.0.113.7'); // raw IP never serialized
    expect(tok['r-a']).toBe(tok['r-b']); // same IP → same token (repeat-source signal)
    expect(tok['r-a']).not.toBe(tok['r-c']);
    expect(tok['r-a']).not.toBe('203.0.113.7');
  });
});

describe('getAdminSandboxStats + deleteSimulatorRun (§24.164)', () => {
  it('counts runs + today spend', () => {
    seedAdminRun('s1', { cost: 30 });
    seedAdminRun('s2', { cost: 12 });
    seedAdminRun('s-week', { cost: 99, ts: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const stats = getAdminSandboxStats();
    expect(stats.total).toBe(3);
    expect(stats.runsToday).toBe(2);
    expect(stats.costTodayCents).toBe(42);
    expect(stats.runs7d).toBe(3);
  });

  it('early-delete removes one run and reports whether a row went', () => {
    seedAdminRun('d1');
    seedAdminRun('d2');
    expect(deleteSimulatorRun('d1')).toBe(true);
    expect(getAdminSimulatorRuns(10).map((r) => r.id)).toEqual(['d2']);
    expect(deleteSimulatorRun('nope')).toBe(false); // unknown id
  });
});
