/**
 * Integration tests for the learnings host actions (STRATEGY §24.107 —
 * rejection-as-fuel).
 *
 *   - handlePersistLearning — CAPTURE: writes a learnings row; serializes a
 *     structured reflections object to JSON; publish flag → reflection_published;
 *     sandbox sessions FORBIDDEN.
 *   - handleReadLearnings  — FUEL: returns reflections filtered by role_category
 *     (newest first), parses JSON reflections back to objects; sandbox FORBIDDEN.
 *
 * Mirrors the harness in pipeline-actions.integration.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { handlePersistLearning, handleReadLearnings } from './learnings-actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-learnings-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const BASE_SESSION = {
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-06-17T00:00:00Z',
};

const OWNER_SESSION: Session = { ...BASE_SESSION, id: 'sess-owner', agent_group_id: 'ag-owner' } as Session;
const SANDBOX_SESSION: Session = { ...BASE_SESSION, id: 'sess-sandbox', agent_group_id: 'ag-sandbox' } as Session;

let inDb: Database.Database;

function seedAgentGroups(): void {
  createAgentGroup({
    id: 'ag-owner',
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-06-17T00:00:00Z',
  });
  createAgentGroup({
    id: 'ag-sandbox',
    name: 'Career Pilot Sandbox',
    folder: 'career-pilot-sandbox',
    agent_provider: null,
    created_at: '2026-06-17T00:00:00Z',
  });
}

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroups();

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────

interface ResponseFrame<T = Record<string, unknown>> {
  type: string;
  requestId: string;
  frame: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}

function readResponse<T = Record<string, unknown>>(requestId: string): ResponseFrame<T> {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return JSON.parse(row.content) as ResponseFrame<T>;
}

function content(payload: Record<string, unknown>) {
  return { requestId: `req-${Math.random().toString(36).slice(2, 10)}`, payload };
}

// ── handlePersistLearning ───────────────────────────────────────────────────

describe('handlePersistLearning', () => {
  it('writes a learnings row and echoes the id + role_category', async () => {
    const c = content({
      kind: 'rejection',
      role_category: 'backend',
      reflections: 'Bombed the system-design round; should have led with distributed-systems depth.',
    });
    await handlePersistLearning(c, OWNER_SESSION, inDb);
    const res = readResponse<{ learning_id: string; published: boolean; role_category: string }>(c.requestId);
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.role_category).toBe('backend');
    expect(res.frame.data.published).toBe(false);

    const rows = getDb().prepare('SELECT * FROM learnings').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('rejection');
    expect(rows[0].role_category).toBe('backend');
    expect(rows[0].reflection_published).toBe(0);
  });

  it('serializes a structured reflections object to JSON', async () => {
    const c = content({
      kind: 'interview',
      role_category: 'platform',
      reflections: { round: 'onsite', gut_read: 'fit', note: 'they wanted Kafka' },
    });
    await handlePersistLearning(c, OWNER_SESSION, inDb);
    const row = getDb().prepare('SELECT reflections FROM learnings').get() as { reflections: string };
    expect(JSON.parse(row.reflections)).toEqual({ round: 'onsite', gut_read: 'fit', note: 'they wanted Kafka' });
  });

  it('sets reflection_published when publish is true', async () => {
    const c = content({ kind: 'rejection', role_category: 'ai', reflections: 'noise, moving on', publish: true });
    await handlePersistLearning(c, OWNER_SESSION, inDb);
    const res = readResponse<{ published: boolean }>(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.published).toBe(true);
    const row = getDb().prepare('SELECT reflection_published FROM learnings').get() as { reflection_published: number };
    expect(row.reflection_published).toBe(1);
  });

  it('rejects an empty/whitespace reflections value', async () => {
    const c = content({ kind: 'rejection', reflections: '   ' });
    await handlePersistLearning(c, OWNER_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('BAD_ARGS');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM learnings').get()).toMatchObject({ n: 0 });
  });

  it('FORBIDs a sandbox session (defense-in-depth) and writes nothing', async () => {
    const c = content({ kind: 'rejection', reflections: 'x' });
    await handlePersistLearning(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM learnings').get()).toMatchObject({ n: 0 });
  });
});

// ── handleReadLearnings ──────────────────────────────────────────────────────

describe('handleReadLearnings', () => {
  async function seed(kind: string, roleCategory: string, reflections: unknown): Promise<void> {
    const c = content({ kind, role_category: roleCategory, reflections });
    await handlePersistLearning(c, OWNER_SESSION, inDb);
  }

  it('returns reflections filtered by role_category, newest first, JSON parsed', async () => {
    await seed('rejection', 'backend', { note: 'first' });
    await seed('rejection', 'ai', 'unrelated');
    await seed('rejection', 'backend', { note: 'second' });

    const c = content({ role_category: 'backend' });
    await handleReadLearnings(c, OWNER_SESSION, inDb);
    const res = readResponse<{ learnings: Array<Record<string, unknown>>; count: number }>(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.count).toBe(2); // the ai row is excluded
    // Newest first → "second" then "first"; reflections parsed back to objects.
    expect(res.frame.data.learnings.map((l) => (l.reflections as { note: string }).note)).toEqual(['second', 'first']);
  });

  it('returns an empty list when nothing matches (a fresh search has no history)', async () => {
    const c = content({ role_category: 'backend' });
    await handleReadLearnings(c, OWNER_SESSION, inDb);
    const res = readResponse<{ learnings: unknown[]; count: number }>(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.count).toBe(0);
    expect(res.frame.data.learnings).toEqual([]);
  });

  it('FORBIDs a sandbox session', async () => {
    const c = content({ role_category: 'backend' });
    await handleReadLearnings(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});
