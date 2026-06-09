import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./interview-kit-actions.js', () => ({
  archiveKitsForApplication: vi.fn(async () => 1),
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';

import { archiveKitsForApplication } from './interview-kit-actions.js';
import { upsertInterviewKit } from './interview-kit-store.js';
import { enqueueKitWake, kitWakeSeriesId, reactToStatusTransitions } from './interview-kit-trigger.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-kit-trigger-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');
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
  vi.clearAllMocks();
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedApp(id: string, status: string): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (?, 'Acme', ?, 'obfuscated', 'Engineer', ?, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(id, `ai-${id}`, status);
}

function setPref(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run(key, value);
}

function wakeRows(): Array<{ content: string; series_id: string }> {
  return inDb.prepare("SELECT content, series_id FROM messages_in WHERE kind = 'task'").all() as Array<{
    content: string;
    series_id: string;
  }>;
}

describe('enqueueKitWake', () => {
  it('inserts a one-off task row with the sentinel + payload, and dedups on the series id', () => {
    expect(enqueueKitWake(inDb, 'app-1', 'TECH_SCREEN')).toBe(true);
    let rows = wakeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].series_id).toBe(kitWakeSeriesId('app-1', 'TECH_SCREEN'));
    const parsed = JSON.parse(rows[0].content) as { prompt: string };
    expect(parsed.prompt).toBe('[scheduled trigger: build-interview-kit] application_id=app-1 round=TECH_SCREEN');

    // a second enqueue for the same (app, round) is deduped
    expect(enqueueKitWake(inDb, 'app-1', 'TECH_SCREEN')).toBe(false);
    rows = wakeRows();
    expect(rows).toHaveLength(1);
  });

  it('normalizes the round to upper-case in the series id + prompt', () => {
    enqueueKitWake(inDb, 'app-1', 'tech_screen');
    expect(wakeRows()[0].series_id).toBe('build-interview-kit:app-1:TECH_SCREEN');
  });
});

describe('reactToStatusTransitions', () => {
  it('enqueues a kit wake on entry to an interview stage', () => {
    seedApp('app-1', 'SCREENING');
    reactToStatusTransitions(getDb(), inDb, [{ application_id: 'app-1', from: 'APPLIED', to: 'TECH_SCREEN' }]);
    const rows = wakeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].series_id).toBe(kitWakeSeriesId('app-1', 'TECH_SCREEN'));
  });

  it('does not enqueue when an active kit already exists for that round', () => {
    seedApp('app-1', 'TECH_SCREEN');
    upsertInterviewKit(getDb(), {
      application_id: 'app-1',
      round: 'TECH_SCREEN',
      interview_type: 'technical_screen',
      drive_file_id: 'doc',
      drive_url: 'u',
      title: 't',
    });
    reactToStatusTransitions(getDb(), inDb, [{ application_id: 'app-1', from: 'SCREENING', to: 'TECH_SCREEN' }]);
    expect(wakeRows()).toHaveLength(0);
  });

  it('does not enqueue when auto-generation is disabled', () => {
    seedApp('app-1', 'APPLIED');
    setPref('interview_kit_auto_generate', 'false');
    reactToStatusTransitions(getDb(), inDb, [{ application_id: 'app-1', from: 'APPLIED', to: 'SCREENING' }]);
    expect(wakeRows()).toHaveLength(0);
  });

  it('archives kits (no wake) on entry to a terminal stage', () => {
    seedApp('app-1', 'REJECTED');
    reactToStatusTransitions(getDb(), inDb, [{ application_id: 'app-1', from: 'TECH_SCREEN', to: 'REJECTED' }]);
    expect(archiveKitsForApplication).toHaveBeenCalledWith(expect.anything(), 'app-1');
    expect(wakeRows()).toHaveLength(0);
  });

  it('ignores non-interview, non-terminal transitions (e.g. APPLIED)', () => {
    seedApp('app-1', 'APPLIED');
    reactToStatusTransitions(getDb(), inDb, [{ application_id: 'app-1', from: 'BOOKMARKED', to: 'APPLIED' }]);
    expect(wakeRows()).toHaveLength(0);
    expect(archiveKitsForApplication).not.toHaveBeenCalled();
  });
});
