/**
 * Tests for the job-scrape bootstrap (Phase 9 §24.51).
 *
 * Mirrors funnel-curator-bootstrap.test.ts — same harness, same idempotency
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
  ensureJobScrapeTask,
  hasLiveJobScrapeTask,
  readJobScrapePreferences,
} from './scrape-jobs-bootstrap.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-js-bootstrap-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_AGENT_GROUP: AgentGroup = {
  id: 'test-agent-group',
  name: 'career-pilot',
  folder: 'career-pilot',
  agent_provider: null,
  created_at: '2026-05-28T00:00:00Z',
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
  created_at: '2026-05-28T00:00:00Z',
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
    id: opts.id ?? 'job-scrape',
    processAfter: '2099-01-01T05:00:00.000Z',
    recurrence: opts.recurrence ?? '0 5 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: '[scheduled trigger: job-scrape]', script: null }),
  });
  if (opts.status !== 'pending') {
    inDb.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(opts.status, opts.id ?? 'job-scrape');
  }
}

describe('readJobScrapePreferences', () => {
  it('returns defaults when preferences table is empty', () => {
    const prefs = readJobScrapePreferences(getDb());
    expect(prefs).toEqual({ enabled: true, cronExpr: '0 5 * * *' });
  });

  it('respects job_scrape_enabled=false', () => {
    setPreference('job_scrape_enabled', 'false');
    expect(readJobScrapePreferences(getDb()).enabled).toBe(false);
  });

  it('treats any value other than "false" as enabled', () => {
    setPreference('job_scrape_enabled', 'true');
    expect(readJobScrapePreferences(getDb()).enabled).toBe(true);
    setPreference('job_scrape_enabled', '1');
    expect(readJobScrapePreferences(getDb()).enabled).toBe(true);
  });

  it('respects custom cron expression', () => {
    setPreference('job_scrape_cron', '0 */12 * * *');
    expect(readJobScrapePreferences(getDb()).cronExpr).toBe('0 */12 * * *');
  });

  it('falls back to default cron when preferences table missing', () => {
    const fakeDb = new Database(':memory:');
    expect(readJobScrapePreferences(fakeDb).cronExpr).toBe('0 5 * * *');
    fakeDb.close();
  });
});

describe('hasLiveJobScrapeTask', () => {
  it('returns false when no tasks exist', () => {
    expect(hasLiveJobScrapeTask(inDb)).toBe(false);
  });

  it('returns true when a pending task exists', () => {
    insertSampleTask({ status: 'pending' });
    expect(hasLiveJobScrapeTask(inDb)).toBe(true);
  });

  it('returns true when a paused task exists', () => {
    insertSampleTask({ status: 'paused' });
    expect(hasLiveJobScrapeTask(inDb)).toBe(true);
  });

  it('returns false when only a completed task exists', () => {
    insertSampleTask({ status: 'completed' });
    expect(hasLiveJobScrapeTask(inDb)).toBe(false);
  });

  it('matches by series_id, not just id', () => {
    insertSampleTask({ id: 'job-scrape', status: 'completed' });
    insertSampleTask({ id: 'task-clone-1', status: 'pending' });
    inDb.prepare("UPDATE messages_in SET series_id = 'job-scrape' WHERE id = 'task-clone-1'").run();
    expect(hasLiveJobScrapeTask(inDb)).toBe(true);
  });

  it('ignores tasks in other series', () => {
    insertSampleTask({ id: 'some-other-task', status: 'pending' });
    expect(hasLiveJobScrapeTask(inDb)).toBe(false);
  });
});

describe('computeNextFireTime', () => {
  it('returns an ISO8601 string in the future', () => {
    const out = computeNextFireTime('0 5 * * *');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(out).getTime()).toBeGreaterThan(Date.now());
  });

  it('throws on invalid cron expression', () => {
    expect(() => computeNextFireTime('not a cron')).toThrow();
  });

  it('respects daily 05:00 schedule (next fire within 24h)', () => {
    const out = computeNextFireTime('0 5 * * *');
    const diff = new Date(out).getTime() - Date.now();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);
  });
});

describe('ensureJobScrapeTask', () => {
  it('inserts a task when none exists', () => {
    const res = ensureJobScrapeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.taskId).toMatch(/^task-\d+-[a-z0-9]+$/);
    expect(res.recurrence).toBe('0 5 * * *');
    expect(res.nextFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = inDb
      .prepare(
        "SELECT id, kind, status, recurrence, content, series_id FROM messages_in WHERE series_id = 'job-scrape'",
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
    expect(row.recurrence).toBe('0 5 * * *');
    expect(row.series_id).toBe('job-scrape');
    expect(row.id).not.toBe('job-scrape');
    const content = JSON.parse(row.content) as { prompt: string; script: string | null };
    expect(content.prompt).toBe('[scheduled trigger: job-scrape]');
    expect(content.script).toBeNull();
  });

  it('is idempotent — no duplicate insert on second call', () => {
    ensureJobScrapeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    const res2 = ensureJobScrapeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res2.action).toBe('skipped_exists');

    const count = (
      inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'job-scrape'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('skips when job_scrape_enabled=false', () => {
    setPreference('job_scrape_enabled', 'false');
    const res = ensureJobScrapeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('skipped_disabled');

    const count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('uses custom cron from preferences', () => {
    setPreference('job_scrape_cron', '0 */8 * * *');
    const res = ensureJobScrapeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.recurrence).toBe('0 */8 * * *');

    const row = inDb.prepare("SELECT recurrence FROM messages_in WHERE series_id = 'job-scrape'").get() as {
      recurrence: string;
    };
    expect(row.recurrence).toBe('0 */8 * * *');
  });

  it('inserts a fresh task when only completed rows exist in the series', () => {
    insertSampleTask({ status: 'completed' });
    const res = ensureJobScrapeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');

    const liveCount = (
      inDb
        .prepare(
          "SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'job-scrape' AND status IN ('pending', 'paused')",
        )
        .get() as { n: number }
    ).n;
    expect(liveCount).toBe(1);
  });
});
