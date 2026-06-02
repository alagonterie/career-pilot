/**
 * Tests for the daily-briefing bootstrap (Phase 3.1 §24.6 component 1).
 *
 * Uses the same harness as actions.integration.test.ts: real migrated
 * central DB (in-memory) for the preferences table, real session inbound.db
 * for messages_in. Idempotency cases mirror the production code path —
 * insert via `insertTask`, query via the production `hasLiveDailyBriefingTask`
 * helper.
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
  ensureDailyBriefingTask,
  hasLiveDailyBriefingTask,
  readBriefingPreferences,
} from './daily-briefing-bootstrap.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-bootstrap-test-${process.pid}`);
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
    id: opts.id ?? 'daily-briefing',
    processAfter: '2099-01-01T08:00:00.000Z',
    recurrence: opts.recurrence ?? '0 8 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: '[scheduled trigger: daily-briefing]', script: null }),
  });
  // insertTask defaults status to 'pending'; override if a test needs another.
  if (opts.status !== 'pending') {
    inDb.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(opts.status, opts.id ?? 'daily-briefing');
  }
}

// ── readBriefingPreferences ───────────────────────────────────────────────

describe('readBriefingPreferences', () => {
  it('returns defaults when preferences table is empty', () => {
    const prefs = readBriefingPreferences(getDb());
    expect(prefs).toEqual({ enabled: true, cronExpr: '0 8 * * *' });
  });

  it('respects daily_briefing_enabled=false', () => {
    setPreference('daily_briefing_enabled', 'false');
    expect(readBriefingPreferences(getDb()).enabled).toBe(false);
  });

  it('treats any value other than "false" as enabled', () => {
    setPreference('daily_briefing_enabled', 'true');
    expect(readBriefingPreferences(getDb()).enabled).toBe(true);
    setPreference('daily_briefing_enabled', '1');
    expect(readBriefingPreferences(getDb()).enabled).toBe(true);
  });

  it('respects custom cron expression', () => {
    setPreference('daily_briefing_time', '30 7 * * *');
    expect(readBriefingPreferences(getDb()).cronExpr).toBe('30 7 * * *');
  });

  it('falls back to default cron when preferences table missing', () => {
    const fakeDb = new Database(':memory:');
    expect(readBriefingPreferences(fakeDb).cronExpr).toBe('0 8 * * *');
    fakeDb.close();
  });
});

// ── hasLiveDailyBriefingTask ──────────────────────────────────────────────

describe('hasLiveDailyBriefingTask', () => {
  it('returns false when no tasks exist', () => {
    expect(hasLiveDailyBriefingTask(inDb)).toBe(false);
  });

  it('returns true when a pending task exists', () => {
    insertSampleTask({ status: 'pending' });
    expect(hasLiveDailyBriefingTask(inDb)).toBe(true);
  });

  it('returns true when a paused task exists', () => {
    insertSampleTask({ status: 'paused' });
    expect(hasLiveDailyBriefingTask(inDb)).toBe(true);
  });

  it('returns false when only a completed task exists', () => {
    insertSampleTask({ status: 'completed' });
    expect(hasLiveDailyBriefingTask(inDb)).toBe(false);
  });

  it('matches by series_id, not just id', () => {
    // Recurrence-clone path: original 'daily-briefing' row completes,
    // a fresh row with id='task-<rand>' but series_id='daily-briefing'
    // is the live one.
    insertSampleTask({ id: 'daily-briefing', status: 'completed' });
    insertSampleTask({ id: 'task-clone-1', status: 'pending' });
    // The second insertTask sets series_id=id, so override to simulate
    // the recurrence-handler's behavior.
    inDb.prepare("UPDATE messages_in SET series_id = 'daily-briefing' WHERE id = 'task-clone-1'").run();
    expect(hasLiveDailyBriefingTask(inDb)).toBe(true);
  });

  it('ignores tasks in other series', () => {
    insertSampleTask({ id: 'some-other-task', status: 'pending' });
    expect(hasLiveDailyBriefingTask(inDb)).toBe(false);
  });
});

// ── computeNextFireTime ───────────────────────────────────────────────────

describe('computeNextFireTime', () => {
  it('returns an ISO8601 string in the future', () => {
    const out = computeNextFireTime('0 8 * * *');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(out).getTime()).toBeGreaterThan(Date.now());
  });

  it('throws on invalid cron expression', () => {
    expect(() => computeNextFireTime('not a cron')).toThrow();
  });

  it('respects custom cron schedules', () => {
    const out = computeNextFireTime('*/15 * * * *');
    const diff = new Date(out).getTime() - Date.now();
    // Next */15 fires within 15 minutes
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(15 * 60 * 1000 + 60_000);
  });
});

// ── ensureDailyBriefingTask ───────────────────────────────────────────────

describe('ensureDailyBriefingTask', () => {
  it('inserts a task when none exists', () => {
    const res = ensureDailyBriefingTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.taskId).toMatch(/^task-\d+-[a-z0-9]+$/);
    expect(res.recurrence).toBe('0 8 * * *');
    expect(res.nextFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = inDb
      .prepare(
        "SELECT id, kind, status, recurrence, content, series_id FROM messages_in WHERE series_id = 'daily-briefing'",
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
    expect(row.recurrence).toBe('0 8 * * *');
    expect(row.series_id).toBe('daily-briefing');
    expect(row.id).not.toBe('daily-briefing'); // generated id, not the series id
    const content = JSON.parse(row.content) as { prompt: string; script: string | null };
    expect(content.prompt).toBe('[scheduled trigger: daily-briefing]');
    expect(content.script).toBeNull();
  });

  it('is idempotent — no duplicate insert on second call', () => {
    ensureDailyBriefingTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    const res2 = ensureDailyBriefingTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res2.action).toBe('skipped_exists');

    const count = (
      inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'daily-briefing'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('skips when daily_briefing_enabled=false', () => {
    setPreference('daily_briefing_enabled', 'false');
    const res = ensureDailyBriefingTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('skipped_disabled');

    const count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('uses custom cron from preferences', () => {
    setPreference('daily_briefing_time', '30 7 * * *');
    const res = ensureDailyBriefingTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.recurrence).toBe('30 7 * * *');

    const row = inDb.prepare("SELECT recurrence FROM messages_in WHERE series_id = 'daily-briefing'").get() as {
      recurrence: string;
    };
    expect(row.recurrence).toBe('30 7 * * *');
  });

  it('inserts a fresh task when only completed rows exist in the series', () => {
    insertSampleTask({ status: 'completed' });
    const res = ensureDailyBriefingTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');

    const liveCount = (
      inDb
        .prepare(
          "SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'daily-briefing' AND status IN ('pending', 'paused')",
        )
        .get() as { n: number }
    ).n;
    expect(liveCount).toBe(1);
  });
});
