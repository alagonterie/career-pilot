/**
 * Sub-milestone 5.4a — proactive suppression in handleRecurrence
 * (STRATEGY.md §24.18). While the system pause_state is not 'active', the
 * recurrence fanout does NOT advance: completed recurring rows keep their
 * recurrence so the chain resumes cleanly after /resume (occurrences deferred,
 * not dropped). Reactive flows never route through here.
 *
 * Kept in its own file (NOT recurrence.test.ts, which is Windows-excluded for
 * an unrelated file-DB EBUSY quirk) and uses an in-memory inbound DB so it runs
 * on every platform. The central DB (for getPauseState/setPauseState) is the
 * in-memory test DB; the inbound messages live in a separate in-memory handle.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { setPauseState } from '../portal/system-modes.js';
import { insertTask } from './db.js';
import { handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';

function freshInboundDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  return db;
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

function seedCompletedRecurring(db: Database.Database): void {
  insertTask(db, {
    id: 'task-1',
    processAfter: '2020-01-01T00:00:00.000Z',
    recurrence: '0 9 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: 'daily digest' }),
  });
  db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();
}

describe('handleRecurrence — pause-state proactive suppression', () => {
  let inDb: Database.Database;

  beforeEach(() => {
    closeDb();
    runMigrations(initTestDb());
    inDb = freshInboundDb();
  });

  afterEach(() => {
    inDb.close();
    closeDb();
  });

  it('does NOT advance the chain while paused (recurrence retained for clean resume)', async () => {
    seedCompletedRecurring(inDb);
    setPauseState('paused', 'owner away', 'owner-1');

    await handleRecurrence(inDb, fakeSession());

    const rows = inDb.prepare(`SELECT id, recurrence FROM messages_in`).all() as Array<{
      id: string;
      recurrence: string | null;
    }>;
    expect(rows).toHaveLength(1); // no clone
    expect(rows[0].recurrence).toBe('0 9 * * *'); // retained, not cleared
  });

  it('advances normally once resumed to active', async () => {
    seedCompletedRecurring(inDb);
    setPauseState('active', null, 'owner-1');

    await handleRecurrence(inDb, fakeSession());

    const count = (inDb.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(2); // original + cloned next occurrence
  });

  it('suppresses under halted too', async () => {
    seedCompletedRecurring(inDb);
    setPauseState('halted', null, 'owner-1');

    await handleRecurrence(inDb, fakeSession());

    const count = (inDb.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('defaults to active behaviour when system_modes is empty', async () => {
    seedCompletedRecurring(inDb);
    // No setPauseState call — system_modes empty → getPauseState() === 'active'.
    await handleRecurrence(inDb, fakeSession());

    const count = (inDb.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(2);
  });
});
