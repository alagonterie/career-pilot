/**
 * Integration tests for the contact recall host action (STRATEGY §24.121).
 *
 *   - handleReadContacts — RECALL: returns persisted /contact submissions
 *     (newest first), optional company filter; sandbox sessions FORBIDDEN.
 *
 * Mirrors the harness in learnings-actions.integration.test.ts.
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

import { handleReadContacts } from './contacts-actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-contacts-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const BASE_SESSION = {
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-06-18T00:00:00Z',
};
const OWNER_SESSION: Session = { ...BASE_SESSION, id: 'sess-owner', agent_group_id: 'ag-owner' } as Session;
const SANDBOX_SESSION: Session = { ...BASE_SESSION, id: 'sess-sandbox', agent_group_id: 'ag-sandbox' } as Session;

let inDb: Database.Database;

function seedAgentGroups(): void {
  createAgentGroup({ id: 'ag-owner', name: 'CP', folder: 'career-pilot', agent_provider: null, created_at: 'x' });
  createAgentGroup({
    id: 'ag-sandbox',
    name: 'CP Sandbox',
    folder: 'career-pilot-sandbox',
    agent_provider: null,
    created_at: 'x',
  });
}

function seedContact(id: string, company: string, createdAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO contact_submissions
         (id, name, email, company, role, source, message, fingerprint, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, 'Sam Recruiter', `${id}@acme.example`, company, 'EM', null, 'We are hiring.', `fp-${id}`, 1, createdAt);
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

interface ResponseFrame<T = Record<string, unknown>> {
  frame: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}
function readResponse<T = Record<string, unknown>>(requestId: string): ResponseFrame<T> {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as {
    content: string;
  };
  return JSON.parse(row.content) as ResponseFrame<T>;
}
function content(payload: Record<string, unknown>) {
  return { requestId: `req-${Math.random().toString(36).slice(2, 10)}`, payload };
}

describe('handleReadContacts (§24.121)', () => {
  it('returns recent contacts newest-first, filterable by company', async () => {
    seedContact('a', 'Acme Corp', '2026-06-18T10:00:00Z');
    seedContact('b', 'Globex', '2026-06-18T11:00:00Z');
    seedContact('c', 'Acme Corp', '2026-06-18T12:00:00Z');

    const all = content({});
    await handleReadContacts(all, OWNER_SESSION, inDb);
    const allRes = readResponse<{ contacts: Array<{ id: string }>; count: number }>(all.requestId);
    if (!allRes.frame.ok) throw new Error('unreachable');
    expect(allRes.frame.data.count).toBe(3);
    expect(allRes.frame.data.contacts.map((c) => c.id)).toEqual(['c', 'b', 'a']); // newest first

    const acme = content({ company: 'Acme' });
    await handleReadContacts(acme, OWNER_SESSION, inDb);
    const acmeRes = readResponse<{ contacts: Array<{ id: string }>; count: number }>(acme.requestId);
    if (!acmeRes.frame.ok) throw new Error('unreachable');
    expect(acmeRes.frame.data.count).toBe(2);
    expect(acmeRes.frame.data.contacts.map((c) => c.id)).toEqual(['c', 'a']);
  });

  it('returns an empty list when there are no contacts', async () => {
    const c = content({});
    await handleReadContacts(c, OWNER_SESSION, inDb);
    const res = readResponse<{ contacts: unknown[]; count: number }>(c.requestId);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.count).toBe(0);
    expect(res.frame.data.contacts).toEqual([]);
  });

  it('FORBIDs a sandbox session (private recruiter PII)', async () => {
    seedContact('a', 'Acme Corp', '2026-06-18T10:00:00Z');
    const c = content({});
    await handleReadContacts(c, SANDBOX_SESSION, inDb);
    const res = readResponse(c.requestId);
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('FORBIDDEN');
  });
});
