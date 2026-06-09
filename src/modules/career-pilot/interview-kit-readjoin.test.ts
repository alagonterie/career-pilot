import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { handleReadFunnelState } from './funnel-actions.js';
import { upsertInterviewKit } from './interview-kit-store.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-kit-readjoin-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'test-session-1',
  agent_group_id: 'ag-owner',
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
  createAgentGroup({
    id: 'ag-owner',
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-05-28T00:00:00Z',
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

function seedApp(id: string, status = 'TECH_SCREEN'): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (?, ?, ?, 'obfuscated', 'Engineer', ?, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(id, `Co ${id}`, `ai-${id}`, status);
}

function insertCuratorOutput(narratives: unknown[], attention: unknown[]): void {
  getDb()
    .prepare(
      `INSERT INTO funnel_curator_output
         (id, run_at, gmail_history_id, calendar_sync_tokens, narratives_json, attention_json, suggestions_json, cheap_out, cost_usd)
       VALUES ('run-1', datetime('now'), NULL, '{}', @n, @a, '[]', 0, NULL)`,
    )
    .run({ n: JSON.stringify(narratives), a: JSON.stringify(attention) });
}

interface ReadResp {
  frame:
    | {
        ok: true;
        data: {
          state: { narratives: Array<Record<string, unknown>>; attention: Array<Record<string, unknown>> } | null;
        };
      }
    | { ok: false; error: { code: string } };
}

function readState(): ReadResp {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get('cp-resp-r1') as { content: string };
  return JSON.parse(row.content) as ReadResp;
}

describe('read_funnel_state — kit_url join (§24.53)', () => {
  it('hangs the active kit_url on narratives + attention by application_id; leaves kit-less apps bare', async () => {
    seedApp('app-1');
    seedApp('app-2');
    upsertInterviewKit(getDb(), {
      application_id: 'app-1',
      round: 'TECH_SCREEN',
      interview_type: 'technical_screen',
      drive_file_id: 'doc-1',
      drive_url: 'https://docs.google.com/document/d/doc-1/edit',
      title: 'Interview Kit — Co app-1 — Tech Screen',
    });
    insertCuratorOutput(
      [
        { company: 'Co app-1', application_id: 'app-1', current_state: 'interviewing', timeline_excerpt: [] },
        { company: 'Co app-2', application_id: 'app-2', current_state: 'applied', timeline_excerpt: [] },
      ],
      [
        {
          priority: 'same_day',
          reason: 'onsite tomorrow',
          application_id: 'app-1',
          company: 'Co app-1',
          action_hint: null,
        },
      ],
    );

    await handleReadFunnelState({ requestId: 'r1' }, FAKE_SESSION, inDb);
    const resp = readState();
    expect(resp.frame.ok).toBe(true);
    if (!resp.frame.ok) return;
    const state = resp.frame.data.state!;

    const n1 = state.narratives.find((n) => n.application_id === 'app-1');
    const n2 = state.narratives.find((n) => n.application_id === 'app-2');
    expect(n1?.kit_url).toBe('https://docs.google.com/document/d/doc-1/edit');
    expect(n2?.kit_url).toBeUndefined();
    expect(state.attention[0].kit_url).toBe('https://docs.google.com/document/d/doc-1/edit');
  });

  it('returns state with no kit_url fields when there are no kits', async () => {
    seedApp('app-1');
    insertCuratorOutput(
      [{ company: 'Co app-1', application_id: 'app-1', current_state: 'applied', timeline_excerpt: [] }],
      [],
    );
    await handleReadFunnelState({ requestId: 'r1' }, FAKE_SESSION, inDb);
    const resp = readState();
    expect(resp.frame.ok).toBe(true);
    if (!resp.frame.ok) return;
    expect(resp.frame.data.state!.narratives[0].kit_url).toBeUndefined();
  });
});
