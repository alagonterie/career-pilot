/**
 * Proactive health-alert tests (STRATEGY.md §24.68 D-B/D6).
 *
 * Core invariants: a NEW critical finding alerts exactly once (state row
 * dedupes until it clears); a cleared finding re-alerts on re-occurrence; the
 * dedupe ledger survives across runs (it's a table); the maintenance entry
 * point honors its throttles, prunes retention, and never throws — even with
 * no delivery adapter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { setDeliveryAdapter } from '../../delivery.js';

import { _resetMaintenanceThrottleForTesting, reconcileAlertState, runTelemetryMaintenance } from './health-alert.js';
import type { HealthFinding } from './health.js';

const NOW_ISO = '2026-06-12T18:00:00.000Z';

function critical(id: string): HealthFinding {
  return { id, severity: 'critical', title: `critical ${id}`, detail: '' };
}

function stateRow(id: string): { cleared_at: string | null } | undefined {
  return getDb().prepare('SELECT cleared_at FROM health_alert_state WHERE finding_id = ?').get(id) as
    | { cleared_at: string | null }
    | undefined;
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  _resetMaintenanceThrottleForTesting();
});

afterEach(() => {
  setDeliveryAdapter(null as never);
  closeDb();
});

describe('reconcileAlertState', () => {
  it('returns a new critical once, then dedupes it while it persists', () => {
    const f = critical('auth-failure:gmail');
    expect(reconcileAlertState([f], NOW_ISO).map((x) => x.id)).toEqual(['auth-failure:gmail']);
    // Still present next interval — already alerted, nothing new.
    expect(reconcileAlertState([f], NOW_ISO)).toEqual([]);
    expect(stateRow('auth-failure:gmail')?.cleared_at).toBeNull();
  });

  it('clears a disappeared finding and re-alerts on re-occurrence', () => {
    const f = critical('onecli-gateway');
    reconcileAlertState([f], NOW_ISO);
    // Finding gone → cleared.
    reconcileAlertState([], NOW_ISO);
    expect(stateRow('onecli-gateway')?.cleared_at).not.toBeNull();
    // Back again → alert again, row re-opened.
    expect(reconcileAlertState([f], NOW_ISO).map((x) => x.id)).toEqual(['onecli-gateway']);
    expect(stateRow('onecli-gateway')?.cleared_at).toBeNull();
  });

  it('ignores warn/ok findings entirely', () => {
    const findings: HealthFinding[] = [
      { id: 'orphan-responses:s1', severity: 'warn', title: 'w', detail: '' },
      { id: 'stale-due-pending', severity: 'ok', title: 'ok', detail: '' },
    ];
    expect(reconcileAlertState(findings, NOW_ISO)).toEqual([]);
    expect(stateRow('orphan-responses:s1')).toBeUndefined();
  });
});

describe('runTelemetryMaintenance', () => {
  function seedOwnerChannel(): void {
    createAgentGroup({
      id: 'ag-owner-alert',
      name: 'Career Pilot',
      folder: 'career-pilot',
      agent_provider: null,
      created_at: NOW_ISO,
    });
    createMessagingGroup({
      id: 'mg-owner-alert',
      channel_type: 'telegram',
      platform_id: 'telegram:1234',
      name: 'Owner DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: NOW_ISO,
    } as never);
    getDb()
      .prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, created_at)
         VALUES ('mga-owner-alert', 'mg-owner-alert', 'ag-owner-alert', 'pattern', ?)`,
      )
      .run(NOW_ISO);
  }

  function seedAuthFailure(): void {
    getDb()
      .prepare(
        `INSERT INTO request_telemetry (id, ts, provider, surface, traffic_class, latency_ms, status_code, ok, error)
         VALUES (@id, @ts, 'gmail', 'sim-inject', 'host', 10, 401, 0, 'invalid_grant')`,
      )
      .run({ id: `rt-${Math.random().toString(36).slice(2, 10)}`, ts: new Date().toISOString() });
  }

  beforeEach(() => {
    // Live probes would shell `onecli` — point at nothing so the probe fails
    // fast as gateway-unreachable (itself a critical the tests tolerate).
    process.env.ONECLI_BIN = 'C:/nonexistent/onecli-for-tests';
  });

  afterEach(() => {
    delete process.env.ONECLI_BIN;
  });

  it('delivers ONE batched owner alert for new criticals, then stays silent while they persist', async () => {
    seedOwnerChannel();
    seedAuthFailure();
    const texts: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        texts.push((JSON.parse(content) as { text: string }).text);
        return 'plat-1';
      },
    });

    await runTelemetryMaintenance();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('auth failure');
    expect(texts[0]).toContain('pnpm health');

    // Same findings next interval — deduped, no second message.
    _resetMaintenanceThrottleForTesting();
    await runTelemetryMaintenance();
    expect(texts).toHaveLength(1);
  });

  it('honors the interval throttle (no health run inside the window)', async () => {
    seedOwnerChannel();
    seedAuthFailure();
    const texts: string[] = [];
    setDeliveryAdapter({
      async deliver() {
        texts.push('x');
        return 'plat-1';
      },
    });
    await runTelemetryMaintenance();
    await runTelemetryMaintenance(); // throttled — interval default 3600s
    expect(texts).toHaveLength(1);
  });

  it('prunes request_telemetry past retention', async () => {
    getDb()
      .prepare(
        `INSERT INTO request_telemetry (id, ts, provider, surface, traffic_class, latency_ms, ok)
         VALUES ('rt-ancient', ?, 'portkey', 'agent-turn', 'host', 1, 1)`,
      )
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString());
    await runTelemetryMaintenance();
    const n = (
      getDb().prepare("SELECT COUNT(*) AS n FROM request_telemetry WHERE id = 'rt-ancient'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  it('never throws with no adapter and no owner group', async () => {
    seedAuthFailure();
    await runTelemetryMaintenance(); // nothing seeded, adapter null — must not throw
  });
});
