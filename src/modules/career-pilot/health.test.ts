/**
 * Health-check library tests (STRATEGY.md §24.68).
 *
 * One test per finding shape: stale due pending rows (the §24.66 starvation
 * signature), dead/overdue ops series, missing ops session, orphan-response
 * pileup, outbound backlog, auth failures + failure streaks + stale surfaces
 * from request_telemetry — plus the all-green report and the exit-code
 * mapping. Live probes are skipped throughout (exercised on the box).
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb as openDbAtPath, openOutboundDbRw } from '../../db/session-db.js';
import { inboundDbPath, outboundDbPath, sessionsBaseDir } from '../../session-manager.js';
import type { Session } from '../../types.js';

import { exitCodeForReport, runHealthChecks, type HealthFinding, type HealthReport } from './health.js';
import { OPS_THREAD_ID } from './ops-session.js';

const GROUP_ID = 'ag-health-test';
const MG_ID = 'mg-health-test';
const NOW = Date.parse('2026-06-12T18:00:00Z');

function groupSessionsDir(): string {
  return path.join(sessionsBaseDir(), GROUP_ID);
}

function seedOwnerGroup(): void {
  createAgentGroup({
    id: GROUP_ID,
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-06-12T00:00:00Z',
  });
  createMessagingGroup({
    id: MG_ID,
    channel_type: 'telegram',
    platform_id: 'telegram:1234',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-06-12T00:00:00Z',
  } as never);
}

function seedSession(id: string, threadId: string | null): Session {
  const session: Session = {
    id,
    agent_group_id: GROUP_ID,
    messaging_group_id: MG_ID,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-06-12T00:00:00Z',
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    )
    .run(session as unknown as Record<string, unknown>);
  const inPath = inboundDbPath(GROUP_ID, id);
  fs.mkdirSync(path.dirname(inPath), { recursive: true });
  ensureSchema(inPath, 'inbound');
  return session;
}

interface TaskRow {
  id: string;
  seriesId?: string | null;
  kind?: string;
  status?: string;
  trigger?: number;
  timestamp?: string;
  processAfter?: string | null;
}

function insertInboundRow(sessionId: string, row: TaskRow): void {
  const db = openDbAtPath(inboundDbPath(GROUP_ID, sessionId));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, series_id, trigger, content)
       VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), @kind, @timestamp, @status, @process_after, @series_id, @trigger, '{}')`,
    ).run({
      id: row.id,
      kind: row.kind ?? 'task',
      timestamp: row.timestamp ?? new Date(NOW).toISOString(),
      status: row.status ?? 'pending',
      process_after: row.processAfter ?? null,
      series_id: row.seriesId ?? null,
      trigger: row.trigger ?? 1,
    });
  } finally {
    db.close();
  }
}

/** A healthy ops session: every series has a pending occurrence due in the future. */
function seedHealthyOps(sessionId = 'sess-ops'): void {
  seedSession(sessionId, OPS_THREAD_ID);
  const future = new Date(NOW + 3_600_000).toISOString();
  for (const series of ['daily-briefing', 'killer-match', 'funnel-curator', 'close-detection', 'job-scrape']) {
    insertInboundRow(sessionId, { id: `task-${series}`, seriesId: series, processAfter: future });
  }
}

function insertTelemetry(over: Partial<Record<string, unknown>>): void {
  getDb()
    .prepare(
      `INSERT INTO request_telemetry (id, ts, provider, surface, traffic_class, latency_ms, status_code, ok, error)
       VALUES (@id, @ts, @provider, @surface, 'host', 10, @status_code, @ok, @error)`,
    )
    .run({
      id: `rt-${Math.random().toString(36).slice(2, 10)}`,
      ts: new Date(NOW - 60_000).toISOString(),
      provider: 'portkey',
      surface: 'agent-turn',
      status_code: 200,
      ok: 1,
      error: null,
      ...over,
    });
}

/** A subagent_progress row in the public mirror (the cascade's observable trace). */
function insertProgressRow(ts: string, agent = 'scrape-jobs'): void {
  getDb()
    .prepare(
      `INSERT INTO public_audit_trail (id, seq, ts, category, agent_name, proactive, application_ref, summary, details_json)
       VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail), @ts, 'subagent_progress', @agent, 0, NULL, 'did a thing', '{}')`,
    )
    .run({ id: `pat-${Math.random().toString(36).slice(2, 10)}`, ts, agent });
}

function find(report: HealthReport, id: string): HealthFinding | undefined {
  return report.findings.find((f) => f.id === id);
}

async function run(): Promise<HealthReport> {
  return runHealthChecks({ skipLiveProbes: true, now: NOW });
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  seedOwnerGroup();
  fs.rmSync(groupSessionsDir(), { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(groupSessionsDir(), { recursive: true, force: true });
  closeDb();
});

describe('runHealthChecks', () => {
  it('reports all-green on a healthy topology and exit code 0', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    insertTelemetry({}); // one recent success
    const report = await run();
    expect(report.findings.every((f) => f.severity === 'ok')).toBe(true);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it('flags stale due pending rows (the §24.66 starvation signature) as critical', async () => {
    const s = seedSession('sess-chat', null);
    seedHealthyOps();
    insertInboundRow(s.id, {
      id: 'starved-task',
      timestamp: new Date(NOW - 3_600_000).toISOString(), // due an hour ago, threshold 900s
    });
    const report = await run();
    const f = find(report, `stale-due-pending:${s.id}`);
    expect(f?.severity).toBe('critical');
    expect(f?.next_step).toContain('scripts/q.ts');
    expect(exitCodeForReport(report)).toBe(2);
  });

  it('ignores trigger=0 context rows when looking for stale pending work', async () => {
    const s = seedSession('sess-chat', null);
    seedHealthyOps();
    insertInboundRow(s.id, {
      id: 'cp-resp-old', // trigger=0 — consumed-or-orphaned context, not starvation
      kind: 'system',
      trigger: 0,
      timestamp: new Date(NOW - 3_600_000).toISOString(),
    });
    const report = await run();
    expect(find(report, 'stale-due-pending')?.severity).toBe('ok');
  });

  it('flags a series whose newest row is terminal with no successor as a dead chain', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    const ops = 'sess-ops';
    // killer-match: retire the pending row and leave only a completed one.
    const db = openDbAtPath(inboundDbPath(GROUP_ID, ops));
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE series_id = 'killer-match'").run();
    db.close();
    const report = await run();
    const f = find(report, 'dead-series:killer-match');
    expect(f?.severity).toBe('critical');
    expect(f?.title).toContain('killer-match');
  });

  it('flags a pending occurrence overdue past the threshold', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    const db = openDbAtPath(inboundDbPath(GROUP_ID, 'sess-ops'));
    // Due 3h ago (> health_series_overdue_threshold_sec = 7200).
    db.prepare("UPDATE messages_in SET process_after = ? WHERE series_id = 'daily-briefing'").run(
      new Date(NOW - 3 * 3_600_000).toISOString(),
    );
    db.close();
    const report = await run();
    expect(find(report, 'dead-series:daily-briefing')?.severity).toBe('critical');
  });

  it('warns when the chat session exists but the ops session does not', async () => {
    seedSession('sess-chat', null);
    const report = await run();
    expect(find(report, 'ops-session-missing')?.severity).toBe('warn');
  });

  it('warns on an orphan-response pileup above the threshold', async () => {
    const s = seedSession('sess-chat', null);
    seedHealthyOps();
    for (let i = 0; i < 26; i++) {
      // warn threshold 25
      insertInboundRow(s.id, { id: `cp-resp-${i}`, kind: 'system', trigger: 0 });
    }
    const report = await run();
    expect(find(report, `orphan-responses:${s.id}`)?.severity).toBe('warn');
  });

  it('warns on an undelivered outbound backlog above the threshold', async () => {
    const s = seedSession('sess-chat', null);
    seedHealthyOps();
    const outPath = outboundDbPath(GROUP_ID, s.id);
    ensureSchema(outPath, 'outbound');
    const outDb = openOutboundDbRw(outPath);
    for (let i = 0; i < 11; i++) {
      // warn threshold 10
      outDb
        .prepare(
          `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, datetime('now'), 'chat', '{}')`,
        )
        .run(`out-${i}`, i * 2 + 1);
    }
    outDb.close();
    const report = await run();
    expect(find(report, `outbound-backlog:${s.id}`)?.severity).toBe('warn');
  });

  it('flags any 401/403 in the last 24h as a critical auth failure with a Gmail-specific next step', async () => {
    insertTelemetry({ provider: 'gmail', surface: 'sim-inject', status_code: 401, ok: 0, error: 'invalid_grant' });
    const report = await run();
    const f = find(report, 'auth-failure:gmail');
    expect(f?.severity).toBe('critical');
    expect(f?.next_step).toContain('consent screen');
  });

  it('flags a provider whose newest N requests all failed as a streak — and clears it after a success', async () => {
    for (let i = 0; i < 3; i++) {
      // streak threshold 3
      insertTelemetry({ provider: 'serpapi', surface: 'serpapi-search', status_code: 429, ok: 0 });
    }
    let report = await run();
    expect(find(report, 'failure-streak:serpapi')?.severity).toBe('critical');

    insertTelemetry({
      provider: 'serpapi',
      surface: 'serpapi-search',
      ts: new Date(NOW - 1_000).toISOString(), // newest
    });
    report = await run();
    expect(find(report, 'failure-streak:serpapi')).toBeUndefined();
  });

  it('warns on an active surface whose newest success is stale — and skips dormant surfaces', async () => {
    // Active-but-failing: old success, recent failures.
    insertTelemetry({
      provider: 'drive',
      surface: 'interview-kit-drive',
      ts: new Date(NOW - 80 * 3_600_000).toISOString(), // success 80h ago (> 48h window)
    });
    insertTelemetry({
      provider: 'drive',
      surface: 'interview-kit-drive',
      ts: new Date(NOW - 3_600_000).toISOString(),
      status_code: 500,
      ok: 0,
    });
    // Dormant: nothing for 80h — no warning.
    insertTelemetry({
      provider: 'lever',
      surface: 'scrape-board',
      ts: new Date(NOW - 80 * 3_600_000).toISOString(),
    });
    const report = await run();
    expect(find(report, 'stale-surface:interview-kit-drive')?.severity).toBe('warn');
    expect(find(report, 'stale-surface:scrape-board')).toBeUndefined();
  });

  // Seed a completed trace-emitting occurrence (due `dueIso`) PLUS a live pending
  // successor on top — the real recurrence shape, so the dead-series check (which
  // reads the newest row by seq) stays green and only cascade-silent reacts.
  function seedCompletedCascadeFire(series: string, dueIso: string): void {
    insertInboundRow('sess-ops', {
      id: `task-${series}-done`,
      seriesId: series,
      status: 'completed',
      processAfter: dueIso,
    });
    insertInboundRow('sess-ops', {
      id: `task-${series}-next`,
      seriesId: series,
      status: 'pending',
      processAfter: new Date(NOW + 3_600_000).toISOString(),
    });
  }

  it('warns when a trace-emitting cascade series fired but recorded no traces (B1, §24.68 Δ)', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    // A completed job-scrape occurrence due 5h ago (inside the 26h window), with a
    // live successor — but zero subagent_progress rows in the window.
    seedCompletedCascadeFire('job-scrape', new Date(NOW - 5 * 3_600_000).toISOString());
    const report = await run();
    const f = find(report, 'cascade-silent');
    expect(f?.severity).toBe('warn');
    expect(f?.next_step).toContain('dev_model_tier');
    expect(exitCodeForReport(report)).toBe(0); // a warn never exit-codes
  });

  it('stays ok when the cascade fired AND recorded a subagent-progress trace', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    seedCompletedCascadeFire('job-scrape', new Date(NOW - 5 * 3_600_000).toISOString());
    insertProgressRow(new Date(NOW - 4 * 3_600_000).toISOString()); // a trace landed in-window
    const report = await run();
    expect(find(report, 'cascade-silent')?.severity).toBe('ok');
  });

  it('stays ok when no trace-emitting series fired in the window (nothing to be silent about)', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps(); // all pending, none completed
    const report = await run();
    expect(find(report, 'cascade-silent')?.severity).toBe('ok');
  });

  it('ignores a trace-emitting occurrence that completed outside the window', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    seedCompletedCascadeFire('job-scrape', new Date(NOW - 30 * 3_600_000).toISOString()); // 30h > 26h window
    const report = await run();
    expect(find(report, 'cascade-silent')?.severity).toBe('ok');
  });

  it('degrades to a warn finding when request_telemetry is missing (read-only stance)', async () => {
    seedSession('sess-chat', null);
    seedHealthyOps();
    getDb().exec('DROP TABLE request_telemetry');
    const report = await run();
    expect(find(report, 'health-check-error:request-telemetry')?.severity).toBe('warn');
    expect(exitCodeForReport(report)).toBe(0); // a warn never exit-codes
  });
});

describe('exitCodeForReport', () => {
  it('maps criticals to 2, anything else to 0', () => {
    const mk = (severity: HealthFinding['severity']): HealthReport => ({
      ranAt: new Date(NOW).toISOString(),
      findings: [{ id: 'x', severity, title: 't', detail: '' }],
    });
    expect(exitCodeForReport(mk('ok'))).toBe(0);
    expect(exitCodeForReport(mk('warn'))).toBe(0);
    expect(exitCodeForReport(mk('critical'))).toBe(2);
  });
});
