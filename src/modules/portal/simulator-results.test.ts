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
  finalizeSimulatorRun,
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

function seedRun(id: string, opts: { company?: string; shareable?: number; expiresAt?: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO simulator_runs (id, ts, visitor_company, visitor_role, shareable, expires_at)
       VALUES (?, ?, ?, 'SWE', ?, ?)`,
    )
    .run(id, new Date().toISOString(), opts.company ?? 'Acme', opts.shareable ?? 1, opts.expiresAt ?? null);
}

describe('run accumulation + finalize', () => {
  it('persists a row on the terminal task message (cost, latency, output)', () => {
    const { simulation_id: id } = startSimulatorRun({ company: 'Acme', role: 'Staff SWE', jd: 'Ship things' });
    expect(id).toBeDefined();

    recordSimulatorOutput(id!, 'trace', { t: 'subagent', subagent: 'research-company' });
    recordSimulatorOutput(id!, 'trace', { t: 'result', cost_usd: 0.041 });
    recordSimulatorOutput(id!, 'chat', { text: 'Tailored bullets…' });
    recordSimulatorOutput(id!, 'task', { text: 'Done — outreach drafted.' });

    const row = getSimulatorResult(id!);
    expect(row).not.toBeNull();
    expect(row!.visitor_company).toBe('Acme');
    expect(row!.total_cost_cents).toBe(4); // round(0.041 * 100)
    expect(row!.jd_excerpt).toBe('Ship things');
    expect(row!.tailored_resume).toContain('Tailored bullets');
    expect(row!.tailored_resume).toContain('Done — outreach drafted.');
    expect(typeof row!.total_latency_ms).toBe('number');
    expect(row!.expires_at).not.toBeNull();
  });

  it('finalize is idempotent — a task/hard-wall race persists exactly once', () => {
    const { simulation_id: id } = startSimulatorRun({ company: 'Acme', role: 'SWE' });
    recordSimulatorOutput(id!, 'task', { text: 'done' });
    // Second finalize (e.g. the hard-wall firing after completion) is a no-op.
    finalizeSimulatorRun(id!, 'hard-wall');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM simulator_runs WHERE id = ?').get(id!) as { c: number })
      .c;
    expect(count).toBe(1);
  });

  it('recordSimulatorOutput on an unknown/finalized run is a no-op (no throw)', () => {
    expect(() => recordSimulatorOutput('sb-nope', 'task', { text: 'x' })).not.toThrow();
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

describe('getRecentSimulatorRuns', () => {
  it('lists recent shareable, non-expired runs (newest first), excluding opted-out', () => {
    seedRun('sb-1', { company: 'A', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    seedRun('sb-2', { company: 'B', shareable: 0, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    seedRun('sb-3', { company: 'C', expiresAt: new Date(Date.now() - 1000).toISOString() }); // expired
    const recent = getRecentSimulatorRuns(10);
    const companies = recent.map((r) => r.visitor_company);
    expect(companies).toContain('A');
    expect(companies).not.toContain('B'); // shareable=0 excluded
    expect(companies).not.toContain('C'); // expired excluded
  });
});
