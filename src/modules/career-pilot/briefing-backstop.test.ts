/**
 * Tests for the daily-briefing host backstop (§24.134b).
 *
 * Pure pieces (parseAttention / renderBackstopDigest / decideBackstop) are
 * tested directly; the orchestrator is exercised with seeded inbound/outbound
 * session DBs + a stub delivery adapter, asserting the never-double-message
 * window heuristic, the once-only marker, and the defer-without-mark path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb, openOutboundDbRw } from '../../db/session-db.js';
import { setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';

import {
  decideBackstop,
  maybeDeliverBriefingBackstop,
  parseAttention,
  renderBackstopDigest,
} from './briefing-backstop.js';
import { OPS_THREAD_ID } from './ops-session.js';

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('parseAttention', () => {
  it('parses a valid array and drops non-objects', () => {
    expect(parseAttention('[{"company":"Acme"}, 7, null, {"reason":"x"}]')).toEqual([
      { company: 'Acme' },
      { reason: 'x' },
    ]);
  });
  it('returns [] for null, non-array, or malformed JSON', () => {
    expect(parseAttention(null)).toEqual([]);
    expect(parseAttention('{}')).toEqual([]);
    expect(parseAttention('not json')).toEqual([]);
  });
});

describe('renderBackstopDigest', () => {
  it('renders a singular header + one item with reason and hint', () => {
    const out = renderBackstopDigest([
      { company: 'Acme', reason: 'recruiter screen requested', action_hint: 'Share your availability' },
    ]);
    expect(out).toContain('1 application needs your attention:');
    expect(out).toContain('• Acme — recruiter screen requested');
    expect(out).toContain('↳ Share your availability');
  });
  it('pluralizes and caps overflow', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ company: `Co${i}`, reason: 'r' }));
    const out = renderBackstopDigest(items);
    expect(out).toContain('10 applications need your attention:');
    expect(out).toContain('…and 2 more.');
  });
  it('falls back to a generic subject when company is missing', () => {
    expect(renderBackstopDigest([{ reason: 'silent past SLA' }])).toContain('• An application — silent past SLA');
  });
});

describe('decideBackstop', () => {
  const base = {
    fireTimeMs: Date.now() - 60_000,
    nowMs: Date.now(),
    maxAgeMs: 120 * 60_000,
    outboundReady: true,
    hasOwnerMessageInWindow: false,
    attentionCount: 1,
  };
  it('delivers when fresh, quiet, and there is news', () => {
    expect(decideBackstop(base)).toBe('deliver');
  });
  it('mark-skips an unparseable fire time', () => {
    expect(decideBackstop({ ...base, fireTimeMs: NaN })).toBe('mark-skip');
  });
  it('mark-skips a stale briefing', () => {
    expect(decideBackstop({ ...base, fireTimeMs: Date.now() - 3 * 60 * 60_000 })).toBe('mark-skip');
  });
  it('defers when outbound is not ready', () => {
    expect(decideBackstop({ ...base, outboundReady: false })).toBe('defer');
  });
  it('mark-skips when an owner message is already in the window', () => {
    expect(decideBackstop({ ...base, hasOwnerMessageInWindow: true })).toBe('mark-skip');
  });
  it('mark-skips when there is no news', () => {
    expect(decideBackstop({ ...base, attentionCount: 0 })).toBe('mark-skip');
  });
});

// ── orchestrator ─────────────────────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-backstop-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');
const outboundPath = path.join(tmpDir, 'outbound.db');

const MG_ID = 'mg-owner';
const OPS_SESSION: Session = {
  id: 'sess-ops',
  agent_group_id: 'ag-cp',
  messaging_group_id: MG_ID,
  thread_id: OPS_THREAD_ID,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-06-19T00:00:00Z',
};

let inDb: Database.Database;
let outDb: Database.Database;
let delivered: Array<{ channelType: string; platformId: string; content: string }>;

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function seedCompletedBriefing(processAfterIso: string): void {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, series_id, content)
       VALUES ('task-bf', 2, 'task', @ts, 'completed', @pa, 'daily-briefing', '{"prompt":"[scheduled trigger: daily-briefing]"}')`,
    )
    .run({ ts: processAfterIso, pa: processAfterIso });
}

function seedCuratorAttention(attentionJson: string): void {
  getDb()
    .prepare(
      `INSERT INTO funnel_curator_output (id, run_at, narratives_json, attention_json, suggestions_json, cheap_out)
       VALUES ('fco-1', @ra, '[]', @aj, '[]', 0)`,
    )
    .run({ ra: isoMinutesAgo(20), aj: attentionJson });
}

function seedOwnerOutboundAt(iso: string): void {
  outDb
    .prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-1', 1, @ts, 'chat', 'telegram:123', 'telegram', '{"text":"hi"}')`,
    )
    .run({ ts: iso });
}

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
  ensureSchema(outboundPath, 'outbound');
});

afterAll(() => {
  inDb?.close();
  outDb?.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
  const central = initTestDb();
  runMigrations(central);
  central
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at)
       VALUES (@id, 'telegram', 'telegram:123', 'Owner', '2026-06-19T00:00:00Z')`,
    )
    .run({ id: MG_ID });

  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in; DELETE FROM delivered;');
  outDb = openOutboundDbRw(outboundPath);
  outDb.exec('DELETE FROM messages_out;');

  delivered = [];
  setDeliveryAdapter({
    async deliver(channelType, platformId, _threadId, _kind, content) {
      delivered.push({ channelType, platformId, content });
      return 'plat-msg-id';
    },
  });
});

afterEach(() => {
  inDb?.close();
  outDb?.close();
});

function markerCount(): number {
  return (
    inDb.prepare("SELECT count(*) AS c FROM delivered WHERE message_out_id = 'briefing-backstop:task-bf'").get() as {
      c: number;
    }
  ).c;
}

describe('maybeDeliverBriefingBackstop', () => {
  it('delivers once when a completed briefing left non-empty attention unsurfaced, then is idempotent', async () => {
    seedCompletedBriefing(isoMinutesAgo(2));
    seedCuratorAttention('[{"company":"Acme","reason":"recruiter screen requested","action_hint":"Share times"}]');

    await maybeDeliverBriefingBackstop(inDb, outDb, OPS_SESSION);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe('telegram');
    expect(delivered[0].platformId).toBe('telegram:123');
    expect(delivered[0].content).toContain('Acme');
    expect(markerCount()).toBe(1);

    // second tick: marker present → no second send
    await maybeDeliverBriefingBackstop(inDb, outDb, OPS_SESSION);
    expect(delivered).toHaveLength(1);
  });

  it('does NOT deliver when an owner message already landed in the window (no double-message)', async () => {
    seedCompletedBriefing(isoMinutesAgo(2));
    seedOwnerOutboundAt(isoMinutesAgo(1)); // the briefing emitted (or a coincident push)
    seedCuratorAttention('[{"company":"Acme","reason":"x"}]');

    await maybeDeliverBriefingBackstop(inDb, outDb, OPS_SESSION);
    expect(delivered).toHaveLength(0);
    expect(markerCount()).toBe(1); // marked so we never revisit
  });

  it('does NOT deliver when attention is empty (the silent skip was correct)', async () => {
    seedCompletedBriefing(isoMinutesAgo(2));
    seedCuratorAttention('[]');

    await maybeDeliverBriefingBackstop(inDb, outDb, OPS_SESSION);
    expect(delivered).toHaveLength(0);
    expect(markerCount()).toBe(1);
  });

  it('defers WITHOUT marking when outbound is not yet open (retryable)', async () => {
    seedCompletedBriefing(isoMinutesAgo(2));
    seedCuratorAttention('[{"company":"Acme","reason":"x"}]');

    await maybeDeliverBriefingBackstop(inDb, null, OPS_SESSION);
    expect(delivered).toHaveLength(0);
    expect(markerCount()).toBe(0); // not marked → a later tick with outbound retries
  });

  it('mark-skips a stale briefing (too old to surprise the owner with)', async () => {
    seedCompletedBriefing(isoMinutesAgo(200)); // > 120min max age
    seedCuratorAttention('[{"company":"Acme","reason":"x"}]');

    await maybeDeliverBriefingBackstop(inDb, outDb, OPS_SESSION);
    expect(delivered).toHaveLength(0);
    expect(markerCount()).toBe(1);
  });

  it('is a no-op for a non-ops session', async () => {
    seedCompletedBriefing(isoMinutesAgo(2));
    seedCuratorAttention('[{"company":"Acme","reason":"x"}]');

    await maybeDeliverBriefingBackstop(inDb, outDb, { ...OPS_SESSION, thread_id: null });
    expect(delivered).toHaveLength(0);
    expect(markerCount()).toBe(0);
  });
});
