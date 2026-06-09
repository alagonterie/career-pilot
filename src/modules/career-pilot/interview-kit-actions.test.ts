import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Drive I/O so the handler logic is testable without googleapis creds.
vi.mock('./drive-client.js', () => ({
  createFolder: vi.fn(async (_name: string, parent?: string) => (parent ? 'archive-id' : 'folder-id')),
  createDoc: vi.fn(async (_name: string) => ({
    id: 'doc-123',
    url: 'https://docs.google.com/document/d/doc-123/edit',
  })),
  updateDocContent: vi.fn(async () => true),
  moveFile: vi.fn(async () => true),
  kitMarkdownToHtml: (md: string) => `<html>${md}</html>`,
  docUrl: (id: string) => `https://docs.google.com/document/d/${id}/edit`,
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import type { Session } from '../../types.js';

import { createDoc, createFolder, moveFile, updateDocContent } from './drive-client.js';
import { archiveKitsForApplication, handlePersistInterviewKit } from './interview-kit-actions.js';
import { getActiveKitsForApplication, getKitByApplicationRound, upsertInterviewKit } from './interview-kit-store.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-kit-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

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
  vi.clearAllMocks();
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ResponseFrame {
  frame: { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };
}

function readResponse(requestId: string): ResponseFrame {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response for ${requestId}`);
  return JSON.parse(row.content) as ResponseFrame;
}

function seedApp(id: string, status = 'TECH_SCREEN'): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (?, 'Acme', ?, 'obfuscated', 'Engineer', ?, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(id, `ai-${id}`, status);
}

function persist(reqIdStr: string, patch: Record<string, unknown> = {}) {
  const payload = {
    application_id: 'app-1',
    round: 'TECH_SCREEN',
    interview_type: 'technical_screen',
    title: 'Interview Kit — Acme — Tech Screen',
    markdown: '# Kit\n\n**lean** in',
    ...patch,
  };
  return handlePersistInterviewKit({ requestId: reqIdStr, payload }, FAKE_SESSION, inDb);
}

describe('handlePersistInterviewKit', () => {
  it('creates a new Doc, persists folder ids, inserts the kit row, and returns the link', async () => {
    seedApp('app-1');
    await persist('r1');

    const resp = readResponse('r1');
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) {
      expect(resp.frame.data.drive_url).toBe('https://docs.google.com/document/d/doc-123/edit');
      expect(resp.frame.data.drive_file_id).toBe('doc-123');
      expect(resp.frame.data.round).toBe('TECH_SCREEN');
    }
    expect(createDoc).toHaveBeenCalledTimes(1);
    expect(updateDocContent).not.toHaveBeenCalled();

    const row = getKitByApplicationRound(getDb(), 'app-1', 'TECH_SCREEN');
    expect(row?.drive_file_id).toBe('doc-123');
    expect(row?.status).toBe('active');

    // folder ids were discovered + persisted to the preferences tier
    expect(getConfig(getDb(), 'interview_kit_drive_folder_id', '')).toBe('folder-id');
    expect(getConfig(getDb(), 'interview_kit_drive_archive_folder_id', '')).toBe('archive-id');
  });

  it('updates the existing Doc in place when a kit already exists for (app, round)', async () => {
    seedApp('app-1');
    upsertInterviewKit(getDb(), {
      application_id: 'app-1',
      round: 'TECH_SCREEN',
      interview_type: 'technical_screen',
      drive_file_id: 'existing-doc',
      drive_url: 'https://docs.google.com/document/d/existing-doc/edit',
      title: 'old',
    });

    await persist('r2');

    const resp = readResponse('r2');
    expect(resp.frame.ok).toBe(true);
    if (resp.frame.ok) expect(resp.frame.data.drive_file_id).toBe('existing-doc');
    expect(updateDocContent).toHaveBeenCalledTimes(1);
    expect(createDoc).not.toHaveBeenCalled();
    // still exactly one row for (app, round)
    expect(getDb().prepare("SELECT COUNT(*) c FROM interview_kits WHERE application_id='app-1'").get()).toEqual({
      c: 1,
    });
  });

  it('rejects missing required fields with BAD_ARGS', async () => {
    seedApp('app-1');
    await persist('r3', { markdown: '' });
    const resp = readResponse('r3');
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('BAD_ARGS');
    expect(createDoc).not.toHaveBeenCalled();
  });

  it('surfaces a DRIVE_ERROR when Doc creation fails (no row written)', async () => {
    seedApp('app-1');
    vi.mocked(createDoc).mockResolvedValueOnce(null);
    await persist('r4');
    const resp = readResponse('r4');
    expect(resp.frame.ok).toBe(false);
    if (!resp.frame.ok) expect(resp.frame.error.code).toBe('DRIVE_ERROR');
    expect(getKitByApplicationRound(getDb(), 'app-1', 'TECH_SCREEN')).toBeUndefined();
  });
});

describe('archiveKitsForApplication', () => {
  it('moves each active kit Doc to Archive/ and flips the rows to archived', async () => {
    seedApp('app-1', 'REJECTED');
    upsertInterviewKit(getDb(), {
      application_id: 'app-1',
      round: 'SCREENING',
      interview_type: 'recruiter_screen',
      drive_file_id: 'doc-s',
      drive_url: 'u1',
      title: 't1',
    });
    upsertInterviewKit(getDb(), {
      application_id: 'app-1',
      round: 'TECH_SCREEN',
      interview_type: 'technical_screen',
      drive_file_id: 'doc-t',
      drive_url: 'u2',
      title: 't2',
    });
    // folder ids present so a move is attempted
    getDb()
      .prepare("INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run('interview_kit_drive_folder_id', 'folder-id');
    getDb()
      .prepare("INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run('interview_kit_drive_archive_folder_id', 'archive-id');

    const n = await archiveKitsForApplication(getDb(), 'app-1');
    expect(n).toBe(2);
    expect(moveFile).toHaveBeenCalledTimes(2);
    expect(getActiveKitsForApplication(getDb(), 'app-1')).toHaveLength(0);
  });

  it('is a no-op when the application has no active kits', async () => {
    seedApp('app-2', 'OFFER');
    expect(await archiveKitsForApplication(getDb(), 'app-2')).toBe(0);
    expect(moveFile).not.toHaveBeenCalled();
  });
});
