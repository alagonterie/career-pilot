/**
 * Transcript reader tests (STRATEGY.md §24.198).
 *
 * Two sessions (owner chat + ops) with the two DBs' differing timestamp
 * formats: merged ordering, the two depths (chat-only vs --tools), delivery
 * annotation, every filter, the missing-files warning, and the read-only
 * guarantee (session DB bytes unchanged by a read).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb, openOutboundDbRw } from '../../db/session-db.js';
import { inboundDbPath, outboundDbPath, sessionsBaseDir } from '../../session-manager.js';

import { OPS_THREAD_ID } from './ops-session.js';
import { buildTranscript, parseBound, toIsoUtc } from './transcript.js';

const GROUP_ID = 'ag-transcript-test';
const MG_ID = 'mg-transcript-test';
const CHAT = 'sess-chat';
const OPS = 'sess-ops';
const NOW = Date.parse('2026-06-12T18:00:00Z');

const TEST_SESSIONS_DIR = path.join(os.tmpdir(), `nanoclaw-transcript-test-${process.pid}`);

function seedGroup(): void {
  createAgentGroup({
    id: GROUP_ID,
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-06-12T00:00:00Z',
  });
  createMessagingGroup({
    id: MG_ID,
    channel_type: 'telegram',
    platform_id: 'telegram:1234',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-06-12T00:00:00Z',
  } as never);
}

function seedSession(id: string, threadId: string | null, withFiles = true): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, ?, ?, NULL, 'active', 'stopped', NULL, '2026-06-12T00:00:00Z')`,
    )
    .run(id, GROUP_ID, MG_ID, threadId);
  if (!withFiles) return;
  fs.mkdirSync(path.dirname(inboundDbPath(GROUP_ID, id)), { recursive: true });
  ensureSchema(inboundDbPath(GROUP_ID, id), 'inbound');
  ensureSchema(outboundDbPath(GROUP_ID, id), 'outbound');
}

interface InRow {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;
  channel?: string | null;
  /** Scheduled rows: process_after. */
  due?: string;
  content: unknown;
}

function insertIn(sessionId: string, row: InRow): void {
  const db = openInboundDb(inboundDbPath(GROUP_ID, sessionId));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, channel_type, content)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(row.id, row.seq, row.kind, row.timestamp, row.due ?? null, row.channel ?? null, JSON.stringify(row.content));
  } finally {
    db.close();
  }
}

function insertOut(sessionId: string, row: InRow): void {
  const db = openOutboundDbRw(outboundDbPath(GROUP_ID, sessionId));
  try {
    db.prepare(
      `INSERT INTO messages_out (id, seq, kind, timestamp, channel_type, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.seq, row.kind, row.timestamp, row.channel ?? null, JSON.stringify(row.content));
  } finally {
    db.close();
  }
}

function markDelivery(sessionId: string, messageOutId: string, status: string): void {
  const db = openInboundDb(inboundDbPath(GROUP_ID, sessionId));
  try {
    db.prepare(
      `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, ?, '2026-06-12T15:00:00Z')`,
    ).run(messageOutId, status);
  } finally {
    db.close();
  }
}

/**
 * The fixture conversation:
 *   15:01  ops  → briefing (delivered); mirrored into the chat session as a system row
 *   15:23  chat ← owner message
 *   15:23  chat → tool call / ← tool result (same second as the reply's neighbours)
 *   15:23  chat → reply (delivery failed)
 *   15:40  chat → reaction (never delivered → pending)
 */
function seedConversation(): void {
  seedSession(CHAT, null);
  seedSession(OPS, OPS_THREAD_ID);

  insertIn(OPS, {
    id: 'task-1',
    seq: 2,
    kind: 'task',
    timestamp: '2026-06-12T15:00:00.000Z',
    due: '2026-06-12 15:01:00',
    content: { prompt: 'Run the daily briefing.' },
  });
  insertOut(OPS, {
    id: 'out-brief',
    seq: 3,
    kind: 'chat',
    timestamp: '2026-06-12 15:01:25',
    channel: 'telegram',
    content: { text: 'Needs attention: nothing.' },
  });
  markDelivery(OPS, 'out-brief', 'delivered');

  insertIn(CHAT, {
    id: 'cp-ops-mirror-out-brief',
    seq: 2,
    kind: 'system',
    timestamp: '2026-06-12T15:01:25.900Z',
    content: { type: 'career_pilot_ops_mirror', result: { note: 'Copy', text: 'Needs attention: nothing.' } },
  });
  insertIn(CHAT, {
    id: 'in-owner',
    seq: 4,
    kind: 'chat-sdk',
    timestamp: '2026-06-12T15:23:09.000Z',
    channel: 'telegram',
    content: { text: 'Close the Acme application.', author: { fullName: 'Jane Doe', userId: '1234' }, attachments: [] },
  });
  insertOut(CHAT, {
    id: 'out-call',
    seq: 5,
    kind: 'system',
    timestamp: '2026-06-12 15:23:17',
    channel: 'telegram',
    content: { action: 'career_pilot.update_application', requestId: 'cp-req-1', payload: { id: 'app-acme' } },
  });
  insertIn(CHAT, {
    id: 'in-result',
    seq: 6,
    kind: 'system',
    timestamp: '2026-06-12T15:23:17.628Z',
    content: { type: 'career_pilot_response', requestId: 'cp-req-1', frame: { ok: true, data: { id: 'app-acme' } } },
  });
  insertOut(CHAT, {
    id: 'out-reply',
    seq: 7,
    kind: 'chat',
    timestamp: '2026-06-12 15:23:26',
    channel: 'telegram',
    content: { text: 'Closed.' },
  });
  markDelivery(CHAT, 'out-reply', 'failed');
  insertOut(CHAT, {
    id: 'out-react',
    seq: 9,
    kind: 'chat',
    timestamp: '2026-06-12 15:40:00',
    channel: 'telegram',
    content: { operation: 'reaction', messageId: 'x', emoji: 'eyes' },
  });
}

function ids(entries: { id: string }[]): string[] {
  return entries.map((e) => e.id);
}

beforeAll(() => {
  process.env.NANOCLAW_SESSIONS_DIR = TEST_SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.NANOCLAW_SESSIONS_DIR;
  fs.rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  seedGroup();
  fs.rmSync(path.join(sessionsBaseDir(), GROUP_ID), { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(sessionsBaseDir(), GROUP_ID), { recursive: true, force: true });
  closeDb();
});

describe('toIsoUtc / parseBound', () => {
  it('reads SQLite datetime as UTC and leaves ISO alone', () => {
    expect(toIsoUtc('2026-06-12 15:23:26')).toBe('2026-06-12T15:23:26.000Z');
    expect(toIsoUtc('2026-06-12T15:23:26.500Z')).toBe('2026-06-12T15:23:26.500Z');
    expect(toIsoUtc('not a date')).toBe('not a date');
  });

  it('resolves relative and ISO bounds', () => {
    expect(parseBound('30m', NOW)).toBe(NOW - 30 * 60_000);
    expect(parseBound('24h', NOW)).toBe(NOW - 86_400_000);
    expect(parseBound('7d', NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseBound('2026-06-12T15:00:00Z', NOW)).toBe(Date.parse('2026-06-12T15:00:00Z'));
    expect(parseBound('yesterday', NOW)).toBeNull();
  });
});

describe('buildTranscript', () => {
  it('default depth: only what crossed the channel, merged across sessions in order', () => {
    seedConversation();
    const t = buildTranscript(getDb(), { now: NOW });

    expect(t.group).toMatchObject({ id: GROUP_ID, folder: 'career-pilot' });
    expect(ids(t.entries)).toEqual(['out-brief', 'in-owner', 'out-reply', 'out-react']);
    expect(t.entries.map((e) => e.session_label)).toEqual(['ops', 'chat', 'chat', 'chat']);
    expect(t.entries.map((e) => e.role)).toEqual(['agent', 'user', 'agent', 'agent']);
    expect(t.entries[1]).toMatchObject({
      sender: 'Jane Doe',
      text: 'Close the Acme application.',
      channel: 'telegram',
    });
    expect(t.entries[3].text).toBe('[reaction: eyes]');
    expect(t.warnings).toEqual([]);
  });

  it('annotates outbound chat rows with their delivery outcome', () => {
    seedConversation();
    const byId = new Map(buildTranscript(getDb(), { now: NOW }).entries.map((e) => [e.id, e]));
    expect(byId.get('out-brief')?.status).toBe('delivered');
    expect(byId.get('out-reply')?.status).toBe('failed');
    expect(byId.get('out-react')?.status).toBe('pending');
  });

  it('--tools adds tool calls/results (paired by request id), tasks and mirrors, in seq order', () => {
    seedConversation();
    const t = buildTranscript(getDb(), { now: NOW, includeTools: true });

    expect(ids(t.entries)).toEqual([
      'task-1',
      'out-brief',
      'cp-ops-mirror-out-brief',
      'in-owner',
      'out-call',
      'in-result',
      'out-reply',
      'out-react',
    ]);
    const call = t.entries.find((e) => e.id === 'out-call');
    const result = t.entries.find((e) => e.id === 'in-result');
    expect(call).toMatchObject({ role: 'tool_call', request_id: 'cp-req-1' });
    expect(call?.text).toBe('career_pilot.update_application {"id":"app-acme"}');
    expect(result).toMatchObject({ role: 'tool_result', request_id: 'cp-req-1', text: 'ok {"id":"app-acme"}' });
    // A scheduled row carries when it comes due (its `ts` is when it was queued).
    expect(t.entries.find((e) => e.id === 'task-1')).toMatchObject({ role: 'task', due: '2026-06-12T15:01:00.000Z' });
    expect(call?.due).toBeUndefined();
    expect(t.entries.find((e) => e.id === 'cp-ops-mirror-out-brief')).toMatchObject({
      role: 'mirror',
      text: 'Needs attention: nothing.',
    });
    // Tool rows are not delivery-tracked.
    expect(call?.status).toBeUndefined();
  });

  it('renders a failed tool result as an error', () => {
    seedSession(CHAT, null);
    insertIn(CHAT, {
      id: 'in-err',
      seq: 2,
      kind: 'system',
      timestamp: '2026-06-12T15:00:00.000Z',
      content: { type: 'career_pilot_response', requestId: 'cp-req-9', frame: { ok: false, error: 'not found' } },
    });
    const t = buildTranscript(getDb(), { now: NOW, includeTools: true });
    expect(t.entries[0]).toMatchObject({ role: 'tool_result', text: 'ERROR not found' });
  });

  it('filters by session, channel, and time bounds', () => {
    seedConversation();
    const db = getDb();

    expect(ids(buildTranscript(db, { now: NOW, session: OPS }).entries)).toEqual(['out-brief']);
    expect(buildTranscript(db, { now: NOW, session: 'sess-nope' }).warnings[0]).toMatch(/not found/);

    expect(buildTranscript(db, { now: NOW, channel: 'telegram' }).entries).toHaveLength(4);
    const portal = buildTranscript(db, { now: NOW, channel: 'portal' });
    expect(portal.entries).toEqual([]);
    expect(portal.sessions).toEqual([]);

    // Relative lower bound: 15:23:09 is 2h36m51s before NOW (18:00) — `160m` keeps it, `150m` drops it.
    expect(ids(buildTranscript(db, { now: NOW, since: '160m' }).entries)).toEqual([
      'in-owner',
      'out-reply',
      'out-react',
    ]);
    expect(ids(buildTranscript(db, { now: NOW, since: '150m' }).entries)).toEqual(['out-react']);
    // ISO bounds apply across the two timestamp formats.
    expect(
      ids(buildTranscript(db, { now: NOW, since: '2026-06-12T15:23:00Z', until: '2026-06-12T15:30:00Z' }).entries),
    ).toEqual(['in-owner', 'out-reply']);
    expect(buildTranscript(db, { now: NOW, since: 'yesterday' }).warnings[0]).toMatch(/--since/);
  });

  it('--channel keeps system rows of a matching session under --tools', () => {
    seedConversation();
    const t = buildTranscript(getDb(), { now: NOW, includeTools: true, channel: 'telegram' });
    expect(ids(t.entries)).toContain('in-result');
    expect(ids(t.entries)).toContain('task-1');
  });

  it('limit keeps the tail and reports what was omitted', () => {
    seedConversation();
    const t = buildTranscript(getDb(), { now: NOW, limit: 2 });
    expect(ids(t.entries)).toEqual(['out-reply', 'out-react']);
    expect(t.omitted).toBe(2);
    expect(buildTranscript(getDb(), { now: NOW, limit: 0 }).omitted).toBe(0);
  });

  it('reports per-session counts and ranges', () => {
    seedConversation();
    const t = buildTranscript(getDb(), { now: NOW });
    const chat = t.sessions.find((s) => s.id === CHAT);
    expect(chat).toMatchObject({ label: 'chat', channel: 'telegram', in_count: 3, out_count: 3 });
    expect(t.sessions.find((s) => s.id === OPS)).toMatchObject({ label: 'ops', in_count: 1, out_count: 1 });
  });

  it('warns instead of throwing on a session with no files, and on an unknown group', () => {
    seedConversation();
    seedSession('sess-gone', 'thread-x', false);
    const t = buildTranscript(getDb(), { now: NOW });
    expect(t.entries).toHaveLength(4);
    expect(t.warnings.join('\n')).toMatch(/sess-gone.*no inbound\.db/);

    const missing = buildTranscript(getDb(), { now: NOW, group: 'no-such-group' });
    expect(missing.group).toBeNull();
    expect(missing.entries).toEqual([]);
    expect(missing.warnings[0]).toMatch(/not found/);
  });

  it('never modifies the session DBs', () => {
    seedConversation();
    const files = [CHAT, OPS].flatMap((s) => [inboundDbPath(GROUP_ID, s), outboundDbPath(GROUP_ID, s)]);
    const before = files.map((f) => fs.readFileSync(f));
    buildTranscript(getDb(), { now: NOW, includeTools: true });
    files.forEach((f, i) => expect(fs.readFileSync(f).equals(before[i])).toBe(true));
    // No journal/WAL sidecars left behind either.
    const dir = path.dirname(files[0]);
    expect(fs.readdirSync(dir).sort()).toEqual(['inbound.db', 'outbound.db']);
  });
});
