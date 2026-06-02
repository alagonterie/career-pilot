/**
 * Integration + unit tests for the Sub-milestone 5.2 SSE activity stream
 * (STRATEGY.md §24.16):
 *   - GET /api/activity/stream replays backlog from a cursor, then pushes live rows
 *   - a fresh connect (no cursor) gets only post-connect rows, no backlog
 *   - the poll tail is client-gated (inert with no clients)
 */
import type http from 'http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { startPortalApi, stopPortalApi } from './api.js';
import { _activityClientCount, _isTailRunning, addActivityClient, removeActivityClient } from './sse-broadcaster.js';

let base: string;

beforeEach(async () => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  // Tail fast so the test isn't slow.
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES ('portal_sse_tail_interval_ms', '50', '2026-05-29T00:00:00Z')`,
  ).run();
  const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await stopPortalApi();
  closeDb();
});

function seedAudit(seq: number, summary: string): void {
  getDb()
    .prepare(
      `INSERT INTO public_audit_trail (id, seq, ts, category, application_ref, summary)
       VALUES (?, ?, ?, 'funnel', 'fintech-a', ?)`,
    )
    .run(`pat-${seq}`, seq, `2026-05-2${seq}T00:00:00Z`, summary);
}

/**
 * Read the SSE stream until `predicate(buffer)` holds. `onConnect` fires once
 * right after the response headers arrive (used to insert a live row after the
 * client is attached + any backlog replay has been captured server-side). A
 * hard abort guard makes a never-matching predicate fail fast, not hang.
 */
async function drainUntil(
  url: string,
  opts: {
    predicate: (buf: string) => boolean;
    onConnect?: () => void;
    timeoutMs?: number;
  },
): Promise<string> {
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
  let buf = '';
  try {
    const res = await fetch(url, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    opts.onConnect?.();
    while (true) {
      if (opts.predicate(buf)) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    ac.abort();
  } catch {
    // aborted (guard or post-loop) — return whatever we have
  } finally {
    clearTimeout(guard);
  }
  return buf;
}

describe('GET /api/activity/stream', () => {
  it('replays backlog from a cursor, then pushes live rows', async () => {
    seedAudit(1, 'one');
    seedAudit(2, 'two');

    const buf = await drainUntil(`${base}/api/activity/stream?since=0`, {
      onConnect: () => seedAudit(3, 'three'),
      predicate: (b) => b.includes('id: 3'),
    });

    expect(buf).toContain('id: 1');
    expect(buf).toContain('id: 2');
    expect(buf).toContain('id: 3');
    expect(buf).toContain('three');
  });

  it('a fresh connect (no cursor) gets only post-connect rows', async () => {
    seedAudit(1, 'one');
    seedAudit(2, 'two');

    // No ?since → starts live at MAX(seq)=2. Seed seq 3 immediately and expect
    // only it (no backlog replay of 1/2).
    const buf = await drainUntil(`${base}/api/activity/stream`, {
      onConnect: () => seedAudit(3, 'three'),
      predicate: (b) => b.includes('id: 3'),
    });

    expect(buf).toContain('id: 3');
    expect(buf).not.toContain('one');
    expect(buf).not.toContain('two');
  });
});

describe('sse-broadcaster client gating', () => {
  it('the tail is inert with no clients and starts/stops with connections', () => {
    expect(_activityClientCount()).toBe(0);
    expect(_isTailRunning()).toBe(false);

    const fakeRes = { write: () => true, end: () => undefined } as unknown as http.ServerResponse;
    addActivityClient(fakeRes, null);
    expect(_activityClientCount()).toBe(1);
    expect(_isTailRunning()).toBe(true);

    removeActivityClient(fakeRes);
    expect(_activityClientCount()).toBe(0);
    expect(_isTailRunning()).toBe(false);
  });
});
