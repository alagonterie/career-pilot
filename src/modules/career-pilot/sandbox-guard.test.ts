/**
 * Sandbox isolation Layer 2 (Sub-milestone 5.5a, STRATEGY.md §24.19).
 *
 * denyIfNotOwner is the host-side owner gate wrapped around every private
 * career_pilot action in index.ts. It guarantees that even if the sandbox's
 * Layer-1 disallowedTools list is ever misconfigured, a non-owner session
 * (folder !== 'career-pilot') can never read or write candidate data — the
 * handler is short-circuited and a FORBIDDEN response is returned instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { denyIfNotOwner } from './actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-sandbox-guard-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');
let inDb: Database.Database;

function session(agentGroupId: string): Session {
  return {
    id: `sess-${agentGroupId}`,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: '2026-05-29T00:00:00Z',
  };
}

function content(requestId: string): Record<string, unknown> {
  return { action: 'career_pilot.list_applications', requestId, payload: {} };
}

function forbiddenResponse(requestId: string): boolean {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) return false;
  const parsed = JSON.parse(row.content) as { frame: { ok: boolean; error?: { code: string } } };
  return parsed.frame.ok === false && parsed.frame.error?.code === 'FORBIDDEN';
}

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  const now = '2026-05-29T00:00:00Z';
  createAgentGroup({
    id: 'ag-owner',
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: now,
  });
  createAgentGroup({
    id: 'ag-sandbox',
    name: 'Career Pilot (Sandbox)',
    folder: 'career-pilot-sandbox',
    agent_provider: null,
    created_at: now,
  });

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('denyIfNotOwner', () => {
  it('blocks a sandbox session and writes a FORBIDDEN response', () => {
    const blocked = denyIfNotOwner('career_pilot.list_applications', content('r1'), session('ag-sandbox'), inDb);
    expect(blocked).toBe(true);
    expect(forbiddenResponse('r1')).toBe(true);
  });

  it('allows the owner group through (no response written, handler proceeds)', () => {
    const blocked = denyIfNotOwner('career_pilot.list_applications', content('r2'), session('ag-owner'), inDb);
    expect(blocked).toBe(false);
    expect(forbiddenResponse('r2')).toBe(false);
  });

  it('blocks an unknown/missing agent group (fail closed)', () => {
    const blocked = denyIfNotOwner('career_pilot.get_application', content('r3'), session('ag-nonexistent'), inDb);
    expect(blocked).toBe(true);
    expect(forbiddenResponse('r3')).toBe(true);
  });

  it('blocks a sandbox session from record_turn_telemetry (§24.34 is owner-only too)', () => {
    const blocked = denyIfNotOwner('career_pilot.record_turn_telemetry', content('r4'), session('ag-sandbox'), inDb);
    expect(blocked).toBe(true);
    expect(forbiddenResponse('r4')).toBe(true);
  });
});
