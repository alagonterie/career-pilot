/**
 * Tests for the action-response orphan sweep (STRATEGY.md §24.66).
 *
 * Core invariants: only `cp-resp-*` system rows past the TTL are completed —
 * a fresh response a `sendAction` poll may still consume is untouched, and
 * non-response system rows (tasks, channel messages) are never touched.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { expireOrphanedActionResponses } from './orphan-responses.js';

const TEST_DIR = '/tmp/career-pilot-orphan-responses-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

let openDb: ReturnType<typeof openInboundDb> | null = null;

function freshInboundDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  openDb = openInboundDb(DB_PATH);
  return openDb;
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

let seq = 0;
function insertRow(
  db: ReturnType<typeof freshInboundDb>,
  id: string,
  opts: { kind?: string; status?: string; ageSec: number },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    ++seq,
    opts.kind ?? 'system',
    new Date(Date.now() - opts.ageSec * 1000).toISOString(),
    opts.status ?? 'pending',
    JSON.stringify({ type: 'career_pilot_response', requestId: id, frame: { ok: true } }),
  );
}

const statusOf = (db: ReturnType<typeof freshInboundDb>, id: string): string =>
  (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  closeDb();
  initTestDb();
});

afterEach(() => {
  closeDb();
  try {
    openDb?.close();
  } catch {
    // already closed by the test
  }
  openDb = null;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('expireOrphanedActionResponses', () => {
  it('completes cp-resp rows older than the TTL', () => {
    const db = freshInboundDb();
    insertRow(db, 'cp-resp-old', { ageSec: 600 });
    expireOrphanedActionResponses(db, fakeSession());
    expect(statusOf(db, 'cp-resp-old')).toBe('completed');
  });

  it('leaves a fresh cp-resp row pending (a sendAction poll may still consume it)', () => {
    const db = freshInboundDb();
    insertRow(db, 'cp-resp-fresh', { ageSec: 0 });
    expireOrphanedActionResponses(db, fakeSession());
    expect(statusOf(db, 'cp-resp-fresh')).toBe('pending');
  });

  it('honors the TTL boundary (default 300s: 299s stays, 301s expires)', () => {
    const db = freshInboundDb();
    insertRow(db, 'cp-resp-inside', { ageSec: 299 });
    insertRow(db, 'cp-resp-outside', { ageSec: 301 });
    expireOrphanedActionResponses(db, fakeSession());
    expect(statusOf(db, 'cp-resp-inside')).toBe('pending');
    expect(statusOf(db, 'cp-resp-outside')).toBe('completed');
  });

  it('never touches non-cp-resp rows, whatever their age', () => {
    const db = freshInboundDb();
    insertRow(db, 'task-old', { kind: 'task', ageSec: 6000 });
    insertRow(db, 'sys-other-old', { kind: 'system', ageSec: 6000 });
    expireOrphanedActionResponses(db, fakeSession());
    expect(statusOf(db, 'task-old')).toBe('pending');
    expect(statusOf(db, 'sys-other-old')).toBe('pending');
  });

  it('skips already-consumed responses', () => {
    const db = freshInboundDb();
    insertRow(db, 'cp-resp-done', { status: 'completed', ageSec: 600 });
    expireOrphanedActionResponses(db, fakeSession());
    expect(statusOf(db, 'cp-resp-done')).toBe('completed');
  });

  it('never throws on a broken handle', () => {
    const db = freshInboundDb();
    db.close();
    expect(() => expireOrphanedActionResponses(db, fakeSession())).not.toThrow();
  });
});
