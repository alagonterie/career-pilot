/**
 * Tests for the ops-session topology (STRATEGY.md §24.67).
 *
 * Core invariants: the ops session is created exactly once and only after a
 * chat session exists; the five host-bootstrapped series live in it; live
 * copies elsewhere are retired (owner-created tasks untouched); ops spawns
 * get the rotation env, everyone else doesn't; owner-visible ops deliveries
 * mirror into the chat session as trigger=0 context; the synthetic internal
 * thread id never reaches session_routing.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContainerConfig } from '../../container-config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb as openInboundDbAtPath } from '../../db/session-db.js';
import { inboundDbPath, sessionsBaseDir, writeSessionRouting } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';

import {
  _resetEnsureThrottleForTesting,
  applyOpsSpawnEnv,
  ensureOpsTopology,
  findOpsSession,
  isOpsSession,
  mirrorOpsDeliveryToChat,
  OPS_SERIES_IDS,
  OPS_THREAD_ID,
  retireMisplacedSeries,
} from './ops-session.js';

const GROUP_ID = 'ag-ops-test';
const MG_ID = 'mg-ops-test';
const RAW_DIR = '/tmp/career-pilot-ops-session-test';

function groupSessionsDir(): string {
  return path.join(sessionsBaseDir(), GROUP_ID);
}

function seedOwnerGroup(): AgentGroup {
  const group: AgentGroup = {
    id: GROUP_ID,
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-06-12T00:00:00Z',
  };
  createAgentGroup(group);
  createMessagingGroup({
    id: MG_ID,
    channel_type: 'telegram',
    platform_id: 'telegram:1234',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-06-12T00:00:00Z',
  } as never);
  return group;
}

function seedChatSession(id = 'sess-chat'): Session {
  const session: Session = {
    id,
    agent_group_id: GROUP_ID,
    messaging_group_id: MG_ID,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-06-12T00:00:00Z',
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    )
    .run(session);
  // ensureOpsTopology retires series from every non-ops session — give the
  // chat session a real inbound.db so that step has something to open.
  fs.mkdirSync(path.join(sessionsBaseDir(), GROUP_ID, id), { recursive: true });
  ensureSchema(inboundDbPath(GROUP_ID, id), 'inbound');
  return session;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-x',
    agent_group_id: GROUP_ID,
    messaging_group_id: MG_ID,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-06-12T00:00:00Z',
    ...overrides,
  };
}

let seq = 0;
function insertTaskRow(
  db: ReturnType<typeof openInboundDbAtPath>,
  id: string,
  opts: { seriesId: string; status?: string; kind?: string },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, recurrence, series_id, content)
     VALUES (?, ?, ?, datetime('now'), ?, 1, '0 8 * * *', ?, ?)`,
  ).run(id, ++seq, opts.kind ?? 'task', opts.status ?? 'pending', opts.seriesId, JSON.stringify({ prompt: '[x]' }));
}

function freshRawInboundDb(): ReturnType<typeof openInboundDbAtPath> {
  if (fs.existsSync(RAW_DIR)) fs.rmSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const dbPath = path.join(RAW_DIR, 'inbound.db');
  ensureSchema(dbPath, 'inbound');
  return openInboundDbAtPath(dbPath);
}

let rawDb: ReturnType<typeof openInboundDbAtPath> | null = null;

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  _resetEnsureThrottleForTesting();
  if (fs.existsSync(groupSessionsDir())) fs.rmSync(groupSessionsDir(), { recursive: true, force: true });
});

afterEach(() => {
  closeDb();
  rawDb?.close();
  rawDb = null;
  if (fs.existsSync(RAW_DIR)) fs.rmSync(RAW_DIR, { recursive: true, force: true });
  if (fs.existsSync(groupSessionsDir())) fs.rmSync(groupSessionsDir(), { recursive: true, force: true });
});

describe('isOpsSession', () => {
  it('matches only the reserved ops thread id', () => {
    expect(isOpsSession(fakeSession({ thread_id: OPS_THREAD_ID }))).toBe(true);
    expect(isOpsSession(fakeSession({ thread_id: null }))).toBe(false);
    expect(isOpsSession(fakeSession({ thread_id: 'telegram-thread-7' }))).toBe(false);
  });
});

describe('retireMisplacedSeries', () => {
  it('completes live rows of the five series and nulls recurrence; owner tasks untouched', () => {
    rawDb = freshRawInboundDb();
    insertTaskRow(rawDb, 't-brief', { seriesId: 'daily-briefing' });
    insertTaskRow(rawDb, 't-killer', { seriesId: 'killer-match', status: 'paused' });
    insertTaskRow(rawDb, 't-owner', { seriesId: 'remind-follow-up' });
    insertTaskRow(rawDb, 't-done', { seriesId: 'job-scrape', status: 'completed' });

    const retired = retireMisplacedSeries(rawDb);
    expect(retired).toBe(2);

    const row = (id: string) =>
      rawDb!.prepare('SELECT status, recurrence FROM messages_in WHERE id = ?').get(id) as {
        status: string;
        recurrence: string | null;
      };
    expect(row('t-brief')).toEqual({ status: 'completed', recurrence: null });
    expect(row('t-killer')).toEqual({ status: 'completed', recurrence: null });
    // Owner-created series keeps firing.
    expect(row('t-owner')).toEqual({ status: 'pending', recurrence: '0 8 * * *' });
    // Already-completed historical rows keep their recurrence (audit shape).
    expect(row('t-done').status).toBe('completed');
  });
});

describe('ensureOpsTopology', () => {
  it('defers until a chat session exists', () => {
    seedOwnerGroup();
    ensureOpsTopology();
    expect(findOpsSession(GROUP_ID)).toBeUndefined();
  });

  it('creates the ops session once, bootstraps the five series into it, and is idempotent', () => {
    seedOwnerGroup();
    seedChatSession();

    ensureOpsTopology();
    const ops = findOpsSession(GROUP_ID);
    expect(ops).toBeDefined();
    expect(ops!.thread_id).toBe(OPS_THREAD_ID);
    expect(ops!.messaging_group_id).toBe(MG_ID);

    const opsDb = openInboundDbAtPath(inboundDbPath(GROUP_ID, ops!.id));
    try {
      const liveSeries = opsDb
        .prepare("SELECT DISTINCT series_id FROM messages_in WHERE kind = 'task' AND status = 'pending'")
        .all() as Array<{ series_id: string }>;
      expect(new Set(liveSeries.map((r) => r.series_id))).toEqual(new Set(OPS_SERIES_IDS));
    } finally {
      opsDb.close();
    }

    // Second run (throttle reset to simulate a later tick): same session, no dupes.
    _resetEnsureThrottleForTesting();
    ensureOpsTopology();
    const opsAgain = findOpsSession(GROUP_ID);
    expect(opsAgain!.id).toBe(ops!.id);
    const sessionCount = (
      getDb().prepare('SELECT count(*) AS n FROM sessions WHERE agent_group_id = ?').get(GROUP_ID) as { n: number }
    ).n;
    expect(sessionCount).toBe(2); // chat + ops

    const opsDb2 = openInboundDbAtPath(inboundDbPath(GROUP_ID, ops!.id));
    try {
      const taskCount = (
        opsDb2.prepare("SELECT count(*) AS n FROM messages_in WHERE kind = 'task' AND status = 'pending'").get() as {
          n: number;
        }
      ).n;
      expect(taskCount).toBe(OPS_SERIES_IDS.length);
    } finally {
      opsDb2.close();
    }
  });

  it('retires misplaced live series from the chat session', () => {
    seedOwnerGroup();
    const chat = seedChatSession();
    const chatDb = openInboundDbAtPath(inboundDbPath(GROUP_ID, chat.id));
    try {
      insertTaskRow(chatDb, 't-misplaced', { seriesId: 'daily-briefing' });
      insertTaskRow(chatDb, 't-owner', { seriesId: 'remind-follow-up' });
    } finally {
      chatDb.close();
    }

    ensureOpsTopology();

    const chatDb2 = openInboundDbAtPath(inboundDbPath(GROUP_ID, chat.id));
    try {
      const status = (id: string) =>
        (chatDb2.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;
      expect(status('t-misplaced')).toBe('completed');
      expect(status('t-owner')).toBe('pending');
    } finally {
      chatDb2.close();
    }
  });

  it('respects the ensure throttle between ticks', () => {
    seedOwnerGroup();
    seedChatSession();
    ensureOpsTopology();
    const ops = findOpsSession(GROUP_ID)!;
    // Simulate the ops session vanishing; an immediately-following tick is
    // throttled and must NOT recreate it.
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(ops.id);
    ensureOpsTopology();
    expect(findOpsSession(GROUP_ID)).toBeUndefined();
  });
});

describe('applyOpsSpawnEnv', () => {
  const baseConfig = { env: { EXISTING: '1' } } as unknown as ContainerConfig;
  const ownerGroup: AgentGroup = {
    id: GROUP_ID,
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-06-12T00:00:00Z',
  };

  it('merges rotation env for the ops session (defaults from config/defaults.json)', () => {
    const out = applyOpsSpawnEnv(baseConfig, fakeSession({ thread_id: OPS_THREAD_ID }), ownerGroup);
    expect(out.env).toMatchObject({
      EXISTING: '1',
      CLAUDE_TRANSCRIPT_ROTATE_BYTES: '524288',
      CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS: '2',
      NANOCLAW_CONVERSATIONS_DIR: '/workspace/agent/conversations/ops',
    });
    // Input is not mutated.
    expect(baseConfig.env).toEqual({ EXISTING: '1' });
  });

  it('passes non-ops sessions and non-owner groups through unchanged', () => {
    expect(applyOpsSpawnEnv(baseConfig, fakeSession({ thread_id: null }), ownerGroup)).toBe(baseConfig);
    const sandboxGroup: AgentGroup = { ...ownerGroup, folder: 'career-pilot-sandbox' };
    expect(applyOpsSpawnEnv(baseConfig, fakeSession({ thread_id: OPS_THREAD_ID }), sandboxGroup)).toBe(baseConfig);
  });
});

describe('applyOpsSpawnEnv — ops haiku floor (§24.68 Δ B1)', () => {
  const ownerGroup: AgentGroup = {
    id: GROUP_ID,
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: '2026-06-12T00:00:00Z',
  };
  // Simulates the post-materializeContainerJson state when dev_model_tier=haiku
  // downshifted the spawn (orchestrator + every alias → Haiku).
  const haikuConfig = {
    model: 'claude-haiku-4-5',
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
    },
  } as unknown as ContainerConfig;

  let priorEnv: string | undefined;
  beforeEach(() => {
    priorEnv = process.env.ENVIRONMENT;
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = priorEnv;
  });

  function setTier(tier: string): void {
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES ('dev_model_tier', ?, datetime('now'))",
      )
      .run(tier);
  }

  it('clamps the ops session back to Sonnet under dev + haiku (Haiku alias kept)', () => {
    process.env.ENVIRONMENT = 'dev';
    setTier('haiku');
    const out = applyOpsSpawnEnv(haikuConfig, fakeSession({ thread_id: OPS_THREAD_ID }), ownerGroup);
    expect(out.env).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', // kept — WebFetch/WebSearch summarization
    });
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(haikuConfig.model).toBe('claude-haiku-4-5'); // input not mutated
  });

  it('does not add a floor when the tier is not haiku (default/sonnet pass through)', () => {
    process.env.ENVIRONMENT = 'dev';
    setTier('sonnet');
    const out = applyOpsSpawnEnv(haikuConfig, fakeSession({ thread_id: OPS_THREAD_ID }), ownerGroup);
    expect(out.model).toBe('claude-haiku-4-5'); // no floor added here (sonnet tier handled upstream)
    expect(out.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-haiku-4-5');
  });

  it('does not floor outside dev (prod keeps its real models, never downshifted)', () => {
    delete process.env.ENVIRONMENT;
    setTier('haiku');
    const out = applyOpsSpawnEnv(haikuConfig, fakeSession({ thread_id: OPS_THREAD_ID }), ownerGroup);
    expect(out.model).toBe('claude-haiku-4-5');
    expect(out.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-haiku-4-5');
  });

  it('never floors a non-ops session, even under dev + haiku', () => {
    process.env.ENVIRONMENT = 'dev';
    setTier('haiku');
    const out = applyOpsSpawnEnv(haikuConfig, fakeSession({ thread_id: null }), ownerGroup);
    expect(out).toBe(haikuConfig); // early return — unchanged reference
  });
});

describe('mirrorOpsDeliveryToChat', () => {
  function deliveredMsg(text = 'Daily briefing: 3 leads worth a look.') {
    return { id: 'msg-1', kind: 'chat', content: JSON.stringify({ text }) };
  }

  function chatMirrorRows(chatId: string): Array<{ id: string; kind: string; trigger: number; content: string }> {
    const db = openInboundDbAtPath(inboundDbPath(GROUP_ID, chatId));
    try {
      return db
        .prepare("SELECT id, kind, trigger, content FROM messages_in WHERE id LIKE 'cp-ops-mirror-%'")
        .all() as Array<{ id: string; kind: string; trigger: number; content: string }>;
    } finally {
      db.close();
    }
  }

  it('writes a trigger=0 system copy into the chat session for ops-sourced deliveries', () => {
    seedOwnerGroup();
    const chat = seedChatSession();
    const ops = fakeSession({ id: 'sess-ops', thread_id: OPS_THREAD_ID });

    mirrorOpsDeliveryToChat(ops, deliveredMsg());

    const rows = chatMirrorRows(chat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    expect(rows[0].trigger).toBe(0);
    const content = JSON.parse(rows[0].content) as { action: string; result: { text: string } };
    expect(content.action).toBe('career_pilot.ops_mirror');
    expect(content.result.text).toBe('Daily briefing: 3 leads worth a look.');
  });

  it('does nothing for chat-sourced deliveries', () => {
    seedOwnerGroup();
    const chat = seedChatSession();
    mirrorOpsDeliveryToChat(fakeSession({ id: chat.id, thread_id: null }), deliveredMsg());
    expect(chatMirrorRows(chat.id)).toHaveLength(0);
  });

  it('respects the ops_mirror_to_chat toggle', () => {
    seedOwnerGroup();
    const chat = seedChatSession();
    getDb()
      .prepare(
        "INSERT INTO preferences (key, value, updated_at) VALUES ('ops_mirror_to_chat', 'false', datetime('now'))",
      )
      .run();
    mirrorOpsDeliveryToChat(fakeSession({ id: 'sess-ops', thread_id: OPS_THREAD_ID }), deliveredMsg());
    expect(chatMirrorRows(chat.id)).toHaveLength(0);
  });

  it('skips messages with no extractable text and never throws', () => {
    seedOwnerGroup();
    const chat = seedChatSession();
    const ops = fakeSession({ id: 'sess-ops', thread_id: OPS_THREAD_ID });
    expect(() => mirrorOpsDeliveryToChat(ops, { id: 'm', kind: 'chat', content: 'not json' })).not.toThrow();
    expect(() => mirrorOpsDeliveryToChat(ops, { id: 'm2', kind: 'chat', content: '{"files":["a"]}' })).not.toThrow();
    expect(chatMirrorRows(chat.id)).toHaveLength(0);
  });
});

describe('writeSessionRouting — internal thread ids (§24.67)', () => {
  it('nulls internal:-prefixed thread ids in the default reply routing', () => {
    seedOwnerGroup();
    seedChatSession();
    ensureOpsTopology();
    const ops = findOpsSession(GROUP_ID)!;

    writeSessionRouting(GROUP_ID, ops.id);

    const db = openInboundDbAtPath(inboundDbPath(GROUP_ID, ops.id));
    try {
      const routing = db
        .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
        .get() as {
        channel_type: string | null;
        platform_id: string | null;
        thread_id: string | null;
      };
      expect(routing.channel_type).toBe('telegram');
      expect(routing.platform_id).toBe('telegram:1234');
      expect(routing.thread_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps real platform thread ids intact', () => {
    seedOwnerGroup();
    const threaded = seedChatSession('sess-threaded');
    getDb().prepare('UPDATE sessions SET thread_id = ? WHERE id = ?').run('topic-42', threaded.id);

    writeSessionRouting(GROUP_ID, threaded.id);

    const db = openInboundDbAtPath(inboundDbPath(GROUP_ID, threaded.id));
    try {
      const routing = db.prepare('SELECT thread_id FROM session_routing WHERE id = 1').get() as {
        thread_id: string | null;
      };
      expect(routing.thread_id).toBe('topic-42');
    } finally {
      db.close();
    }
  });
});
