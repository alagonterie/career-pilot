/**
 * Tests for the killer-match bootstrap (Phase 3.1 §24.7 component 2).
 *
 * Mirrors daily-briefing-bootstrap.test.ts — same harness, same idempotency
 * cases, different SERIES_ID + cron defaults.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from '../scheduling/db.js';
import type { AgentGroup, Session } from '../../types.js';

import {
  computeNextFireTime,
  ensureKillerMatchTask,
  hasLiveKillerMatchTask,
  readKillerMatchPreferences,
} from './killer-match-bootstrap.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-km-bootstrap-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_AGENT_GROUP: AgentGroup = {
  id: 'test-agent-group',
  name: 'career-pilot',
  folder: 'career-pilot',
  agent_provider: null,
  created_at: '2026-05-27T00:00:00Z',
};

const FAKE_SESSION: Session = {
  id: 'test-session-1',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-27T00:00:00Z',
};

let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setPreference(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

function insertSampleTask(opts: { id?: string; status: string; recurrence?: string | null }): void {
  insertTask(inDb, {
    id: opts.id ?? 'killer-match',
    processAfter: '2099-01-01T08:00:00.000Z',
    recurrence: opts.recurrence ?? '*/30 7-22 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: '[scheduled trigger: killer-match]', script: null }),
  });
  if (opts.status !== 'pending') {
    inDb.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(opts.status, opts.id ?? 'killer-match');
  }
}

describe('readKillerMatchPreferences', () => {
  it('returns defaults when preferences table is empty', () => {
    const prefs = readKillerMatchPreferences(getDb());
    expect(prefs).toEqual({ enabled: true, cronExpr: '*/30 7-22 * * *' });
  });

  it('respects killer_match_enabled=false', () => {
    setPreference('killer_match_enabled', 'false');
    expect(readKillerMatchPreferences(getDb()).enabled).toBe(false);
  });

  it('treats any value other than "false" as enabled', () => {
    setPreference('killer_match_enabled', 'true');
    expect(readKillerMatchPreferences(getDb()).enabled).toBe(true);
    setPreference('killer_match_enabled', '1');
    expect(readKillerMatchPreferences(getDb()).enabled).toBe(true);
  });

  it('respects custom cron expression', () => {
    setPreference('killer_match_cron', '*/15 * * * *');
    expect(readKillerMatchPreferences(getDb()).cronExpr).toBe('*/15 * * * *');
  });

  it('falls back to default cron when preferences table missing', () => {
    const fakeDb = new Database(':memory:');
    expect(readKillerMatchPreferences(fakeDb).cronExpr).toBe('*/30 7-22 * * *');
    fakeDb.close();
  });
});

describe('hasLiveKillerMatchTask', () => {
  it('returns false when no tasks exist', () => {
    expect(hasLiveKillerMatchTask(inDb)).toBe(false);
  });

  it('returns true when a pending task exists', () => {
    insertSampleTask({ status: 'pending' });
    expect(hasLiveKillerMatchTask(inDb)).toBe(true);
  });

  it('returns true when a paused task exists', () => {
    insertSampleTask({ status: 'paused' });
    expect(hasLiveKillerMatchTask(inDb)).toBe(true);
  });

  it('returns false when only a completed task exists', () => {
    insertSampleTask({ status: 'completed' });
    expect(hasLiveKillerMatchTask(inDb)).toBe(false);
  });

  it('matches by series_id, not just id', () => {
    insertSampleTask({ id: 'killer-match', status: 'completed' });
    insertSampleTask({ id: 'task-clone-1', status: 'pending' });
    inDb.prepare("UPDATE messages_in SET series_id = 'killer-match' WHERE id = 'task-clone-1'").run();
    expect(hasLiveKillerMatchTask(inDb)).toBe(true);
  });

  it('ignores tasks in other series', () => {
    insertSampleTask({ id: 'some-other-task', status: 'pending' });
    expect(hasLiveKillerMatchTask(inDb)).toBe(false);
  });
});

describe('computeNextFireTime', () => {
  it('returns an ISO8601 string in the future', () => {
    const out = computeNextFireTime('*/30 7-22 * * *');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(out).getTime()).toBeGreaterThan(Date.now());
  });

  it('throws on invalid cron expression', () => {
    expect(() => computeNextFireTime('not a cron')).toThrow();
  });

  it('respects */30 schedule (next fire within 30min)', () => {
    const out = computeNextFireTime('*/30 * * * *');
    const diff = new Date(out).getTime() - Date.now();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(30 * 60 * 1000 + 60_000);
  });
});

describe('ensureKillerMatchTask', () => {
  it('inserts a task when none exists', () => {
    const res = ensureKillerMatchTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.taskId).toMatch(/^task-\d+-[a-z0-9]+$/);
    expect(res.recurrence).toBe('*/30 7-22 * * *');
    expect(res.nextFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = inDb
      .prepare(
        "SELECT id, kind, status, recurrence, content, series_id FROM messages_in WHERE series_id = 'killer-match'",
      )
      .get() as {
      id: string;
      kind: string;
      status: string;
      recurrence: string;
      content: string;
      series_id: string;
    };
    expect(row.kind).toBe('task');
    expect(row.status).toBe('pending');
    expect(row.recurrence).toBe('*/30 7-22 * * *');
    expect(row.series_id).toBe('killer-match');
    expect(row.id).not.toBe('killer-match');
    const content = JSON.parse(row.content) as { prompt: string; script: string | null };
    expect(content.prompt).toBe('[scheduled trigger: killer-match]');
    // §24.49c: the task now carries the pre-wake eligibility gate, not null.
    expect(content.script).toBe('bun /app/src/career-pilot/check-eligibility.ts killer-match');
  });

  it('is idempotent — no duplicate insert on second call', () => {
    ensureKillerMatchTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    const res2 = ensureKillerMatchTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res2.action).toBe('skipped_exists');

    const count = (
      inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'killer-match'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('skips when killer_match_enabled=false', () => {
    setPreference('killer_match_enabled', 'false');
    const res = ensureKillerMatchTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('skipped_disabled');

    const count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('uses custom cron from preferences', () => {
    setPreference('killer_match_cron', '*/15 * * * *');
    const res = ensureKillerMatchTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.recurrence).toBe('*/15 * * * *');

    const row = inDb.prepare("SELECT recurrence FROM messages_in WHERE series_id = 'killer-match'").get() as {
      recurrence: string;
    };
    expect(row.recurrence).toBe('*/15 * * * *');
  });

  it('inserts a fresh task when only completed rows exist in the series', () => {
    insertSampleTask({ status: 'completed' });
    const res = ensureKillerMatchTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');

    const liveCount = (
      inDb
        .prepare(
          "SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'killer-match' AND status IN ('pending', 'paused')",
        )
        .get() as { n: number }
    ).n;
    expect(liveCount).toBe(1);
  });
});
