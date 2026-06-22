/**
 * Tests for the pipeline-scribe bootstrap (Phase 3.2 §24.9 component 4).
 *
 * Mirrors killer-match-bootstrap.test.ts — same harness, same idempotency
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
  ensurePipelineScribeTask,
  hasLivePipelineScribeTask,
  readPipelineScribePreferences,
} from './pipeline-scribe-bootstrap.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-fc-bootstrap-test-${process.pid}`);
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
    id: opts.id ?? 'pipeline-scribe',
    processAfter: '2099-01-01T08:00:00.000Z',
    recurrence: opts.recurrence ?? '30 7 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    // Seeds the PRE-rename sentinel so the reconcile path has something stale to
    // converge (§24.59 renamed the prompt to pipeline-scribe; deployed boxes hold
    // the old one). hasLive* tests ignore the prompt, so this is safe for all.
    content: JSON.stringify({ prompt: '[scheduled trigger: funnel-curator]', script: null }),
  });
  if (opts.status !== 'pending') {
    inDb.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(opts.status, opts.id ?? 'pipeline-scribe');
  }
}

describe('readPipelineScribePreferences', () => {
  it('returns defaults when preferences table is empty', () => {
    const prefs = readPipelineScribePreferences(getDb());
    expect(prefs).toEqual({ enabled: true, cronExpr: '30 7 * * *' });
  });

  it('respects pipeline_scribe_enabled=false', () => {
    setPreference('pipeline_scribe_enabled', 'false');
    expect(readPipelineScribePreferences(getDb()).enabled).toBe(false);
  });

  it('treats any value other than "false" as enabled', () => {
    setPreference('pipeline_scribe_enabled', 'true');
    expect(readPipelineScribePreferences(getDb()).enabled).toBe(true);
    setPreference('pipeline_scribe_enabled', '1');
    expect(readPipelineScribePreferences(getDb()).enabled).toBe(true);
  });

  it('respects custom cron expression', () => {
    setPreference('pipeline_scribe_cron', '0 */4 * * *');
    expect(readPipelineScribePreferences(getDb()).cronExpr).toBe('0 */4 * * *');
  });

  it('falls back to default cron when preferences table missing', () => {
    const fakeDb = new Database(':memory:');
    expect(readPipelineScribePreferences(fakeDb).cronExpr).toBe('30 7 * * *');
    fakeDb.close();
  });
});

describe('hasLivePipelineScribeTask', () => {
  it('returns false when no tasks exist', () => {
    expect(hasLivePipelineScribeTask(inDb)).toBe(false);
  });

  it('returns true when a pending task exists', () => {
    insertSampleTask({ status: 'pending' });
    expect(hasLivePipelineScribeTask(inDb)).toBe(true);
  });

  it('returns true when a paused task exists', () => {
    insertSampleTask({ status: 'paused' });
    expect(hasLivePipelineScribeTask(inDb)).toBe(true);
  });

  it('returns false when only a completed task exists', () => {
    insertSampleTask({ status: 'completed' });
    expect(hasLivePipelineScribeTask(inDb)).toBe(false);
  });

  it('matches by series_id, not just id', () => {
    insertSampleTask({ id: 'pipeline-scribe', status: 'completed' });
    insertSampleTask({ id: 'task-clone-1', status: 'pending' });
    inDb.prepare("UPDATE messages_in SET series_id = 'pipeline-scribe' WHERE id = 'task-clone-1'").run();
    expect(hasLivePipelineScribeTask(inDb)).toBe(true);
  });

  it('ignores tasks in other series', () => {
    insertSampleTask({ id: 'some-other-task', status: 'pending' });
    expect(hasLivePipelineScribeTask(inDb)).toBe(false);
  });
});

describe('computeNextFireTime', () => {
  it('returns an ISO8601 string in the future', () => {
    const out = computeNextFireTime('30 7 * * *');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(out).getTime()).toBeGreaterThan(Date.now());
  });

  it('throws on invalid cron expression', () => {
    expect(() => computeNextFireTime('not a cron')).toThrow();
  });

  it('respects daily 07:30 schedule (next fire within 24h)', () => {
    const out = computeNextFireTime('30 7 * * *');
    const diff = new Date(out).getTime() - Date.now();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);
  });
});

describe('ensurePipelineScribeTask', () => {
  it('inserts a task when none exists', () => {
    const res = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.taskId).toMatch(/^task-\d+-[a-z0-9]+$/);
    expect(res.recurrence).toBe('30 7 * * *');
    expect(res.nextFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = inDb
      .prepare(
        "SELECT id, kind, status, recurrence, content, series_id FROM messages_in WHERE series_id = 'pipeline-scribe'",
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
    expect(row.recurrence).toBe('30 7 * * *');
    expect(row.series_id).toBe('pipeline-scribe');
    expect(row.id).not.toBe('pipeline-scribe');
    const content = JSON.parse(row.content) as { prompt: string; script: string | null };
    expect(content.prompt).toBe('[scheduled trigger: pipeline-scribe]');
    expect(content.script).toBeNull();
  });

  it('is idempotent — no duplicate insert on second call', () => {
    ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    const res2 = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res2.action).toBe('skipped_exists');

    const count = (
      inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'pipeline-scribe'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('skips when pipeline_scribe_enabled=false', () => {
    setPreference('pipeline_scribe_enabled', 'false');
    const res = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('skipped_disabled');

    const count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('uses custom cron from preferences', () => {
    setPreference('pipeline_scribe_cron', '0 */6 * * *');
    const res = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');
    expect(res.recurrence).toBe('0 */6 * * *');

    const row = inDb.prepare("SELECT recurrence FROM messages_in WHERE series_id = 'pipeline-scribe'").get() as {
      recurrence: string;
    };
    expect(row.recurrence).toBe('0 */6 * * *');
  });

  it('inserts a fresh task when only completed rows exist in the series', () => {
    insertSampleTask({ status: 'completed' });
    const res = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('inserted');

    const liveCount = (
      inDb
        .prepare(
          "SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'pipeline-scribe' AND status IN ('pending', 'paused')",
        )
        .get() as { n: number }
    ).n;
    expect(liveCount).toBe(1);
  });

  it('reconciles a live row holding the pre-rename sentinel to the current prompt (§24.59)', () => {
    // insertSampleTask seeds the legacy '[scheduled trigger: pipeline-scribe]'
    // prompt — exactly what a deployed box holds across the rename deploy.
    insertSampleTask({ status: 'pending' });
    const before = inDb
      .prepare("SELECT process_after, recurrence FROM messages_in WHERE id = 'pipeline-scribe'")
      .get() as { process_after: string; recurrence: string };

    const res = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('reconciled_prompt');
    expect(res.taskId).toBe('pipeline-scribe');

    const row = inDb
      .prepare("SELECT content, process_after, recurrence FROM messages_in WHERE id = 'pipeline-scribe'")
      .get() as { content: string; process_after: string; recurrence: string };
    const content = JSON.parse(row.content) as { prompt: string; script: string | null };
    expect(content.prompt).toBe('[scheduled trigger: pipeline-scribe]');
    expect(content.script).toBeNull();
    // The series schedule is untouched — only the prompt converged.
    expect(row.process_after).toBe(before.process_after);
    expect(row.recurrence).toBe(before.recurrence);

    // No duplicate row, and the next pass is a plain skip.
    const count = (
      inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE series_id = 'pipeline-scribe'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
    expect(ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION).action).toBe('skipped_exists');
  });

  it('reconciles a paused legacy row too', () => {
    insertSampleTask({ status: 'paused' });
    const res = ensurePipelineScribeTask(getDb(), inDb, FAKE_AGENT_GROUP, FAKE_SESSION);
    expect(res.action).toBe('reconciled_prompt');
    const row = inDb.prepare("SELECT status, content FROM messages_in WHERE id = 'pipeline-scribe'").get() as {
      status: string;
      content: string;
    };
    expect(row.status).toBe('paused');
    expect((JSON.parse(row.content) as { prompt: string }).prompt).toBe('[scheduled trigger: pipeline-scribe]');
  });
});
