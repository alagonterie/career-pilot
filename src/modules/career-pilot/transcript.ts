/**
 * Conversation transcript reader (STRATEGY.md §24.198).
 *
 * Rebuilds what was said between a user and an agent group — on any channel —
 * from the per-session `inbound.db` / `outbound.db` files, which retain every
 * row. One conversation is usually several sessions (the owner chat session
 * plus the ops session that sends briefings), so all of a group's sessions are
 * merged into one timeline.
 *
 * Strictly read-only: every session DB is opened `readonly`, nothing is
 * migrated or written, and a session whose files are missing or unreadable
 * becomes a `warnings[]` entry instead of a throw. The caller supplies the
 * central DB handle (the CLI opens it read-only too).
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { inboundDbPath, outboundDbPath } from '../../session-manager.js';

import { OPS_THREAD_ID } from './ops-session.js';

/** Folder of the owner agent group — the default conversation to read. */
export const DEFAULT_TRANSCRIPT_GROUP = 'career-pilot';

const CHAT_KINDS = ['chat', 'chat-sdk'];

export type TranscriptRole = 'user' | 'agent' | 'tool_call' | 'tool_result' | 'mirror' | 'task' | 'system';

export interface TranscriptEntry {
  /** ISO-8601 UTC, normalized across the two DBs' timestamp formats. */
  ts: string;
  session_id: string;
  /** 'chat' | 'ops' | the session's thread id — which session this row lives in. */
  session_label: string;
  /** The row's own channel_type, else its session's messaging-group channel. */
  channel: string | null;
  direction: 'in' | 'out';
  role: TranscriptRole;
  /** Raw row kind (chat, chat-sdk, system, task, …). */
  kind: string;
  id: string;
  seq: number | null;
  /** Display name of the sender, for inbound chat rows. */
  sender?: string;
  /** Rendered, human-readable content. Never truncated here. */
  text: string;
  /** Inbound: the row's processing status. Outbound chat: delivered | failed | pending. */
  status?: string;
  /** Tool-action correlation id — pairs a tool_call with its tool_result. */
  request_id?: string;
  in_reply_to?: string;
  /**
   * Scheduled rows only: when the row becomes due (ISO-UTC). A task row's `ts`
   * is when it was QUEUED — often a day before it fires.
   */
  due?: string;
}

export interface TranscriptSessionInfo {
  id: string;
  label: string;
  channel: string | null;
  thread_id: string | null;
  status: string | null;
  last_active: string | null;
  in_count: number;
  out_count: number;
  first_ts: string | null;
  last_ts: string | null;
}

export interface TranscriptOptions {
  /** Agent group folder or id. Default: the owner group. */
  group?: string;
  /** Only this channel_type (telegram, portal, cli, …). */
  channel?: string;
  /** Only this session id. */
  session?: string;
  /** Lower bound: ISO timestamp, or relative `30m` / `24h` / `7d`. */
  since?: string;
  /** Upper bound, same forms as `since`. */
  until?: string;
  /** Keep only the LAST n entries after filtering. 0/undefined = all. */
  limit?: number;
  /** Include system/task rows (tool calls + results, telemetry, mirrors). */
  includeTools?: boolean;
  /** Clock override for relative bounds (tests). */
  now?: number;
}

export interface Transcript {
  generatedAt: string;
  group: { id: string; folder: string; name: string } | null;
  sessions: TranscriptSessionInfo[];
  entries: TranscriptEntry[];
  /** Entries dropped by `limit` (older than the returned tail). */
  omitted: number;
  warnings: string[];
}

interface SessionRow {
  id: string;
  thread_id: string | null;
  status: string | null;
  last_active: string | null;
  channel_type: string | null;
}

interface MessageRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status?: string | null;
  process_after?: string | null;
  channel_type: string | null;
  in_reply_to?: string | null;
  content: string;
}

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
const RELATIVE_BOUND = /^(\d+)\s*([mhd])$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Normalize either DB's timestamp to ISO-UTC. SQLite `datetime('now')` is UTC without a zone. */
export function toIsoUtc(ts: string): string {
  const candidate = SQLITE_DATETIME.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? ts : new Date(ms).toISOString();
}

/** Resolve an ISO or relative (`30m`, `24h`, `7d`) bound to epoch-ms; null if unparseable. */
export function parseBound(value: string, now: number): number | null {
  const rel = RELATIVE_BOUND.exec(value.trim());
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function compact(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseContent(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sessionLabel(threadId: string | null): string {
  if (threadId === OPS_THREAD_ID) return 'ops';
  return threadId ?? 'chat';
}

type Rendered = Pick<TranscriptEntry, 'role' | 'text' | 'sender' | 'request_id'>;

function renderInbound(row: MessageRow): Rendered {
  const content = parseContent(row.content);
  if (CHAT_KINDS.includes(row.kind)) {
    const author = (content?.author ?? null) as Record<string, unknown> | null;
    const sender = str(author?.fullName) ?? str(author?.userName) ?? str(content?.senderName) ?? str(content?.sender);
    const attachments = Array.isArray(content?.attachments) ? content.attachments.length : 0;
    const body = str(content?.text) ?? (content ? compact(content) : row.content);
    return { role: 'user', sender, text: attachments > 0 ? `${body} [+${attachments} attachment(s)]` : body };
  }
  if (row.kind === 'task') {
    return { role: 'task', text: str(content?.prompt) ?? str(content?.text) ?? row.content };
  }
  if (content?.type === 'career_pilot_response') {
    const frame = (content.frame ?? null) as Record<string, unknown> | null;
    const ok = frame?.ok === true;
    const body = ok ? compact(frame?.data ?? null) : compact(frame?.error ?? frame ?? null);
    return { role: 'tool_result', request_id: str(content.requestId), text: `${ok ? 'ok' : 'ERROR'} ${body}` };
  }
  if (content?.type === 'career_pilot_ops_mirror') {
    const result = (content.result ?? null) as Record<string, unknown> | null;
    return { role: 'mirror', text: str(result?.text) ?? compact(result) };
  }
  return { role: 'system', text: content ? compact(content) : row.content };
}

function renderOutbound(row: MessageRow): Rendered {
  const content = parseContent(row.content);
  if (CHAT_KINDS.includes(row.kind)) {
    if (!content) return { role: 'agent', text: row.content };
    if (content.operation === 'reaction') {
      return { role: 'agent', text: `[reaction: ${compact(content.emoji)}]` };
    }
    if (str(content.questionId)) {
      const options = Array.isArray(content.options)
        ? content.options.map((o) =>
            o && typeof o === 'object' ? compact((o as { label?: unknown }).label ?? o) : compact(o),
          )
        : [];
      const head = [str(content.title), str(content.question)].filter(Boolean).join(' — ');
      return { role: 'agent', text: `[question] ${head}${options.length ? ` (options: ${options.join(' | ')})` : ''}` };
    }
    const body = str(content.text) ?? str(content.markdown) ?? compact(content);
    const files = Array.isArray(content.files) ? content.files.length : 0;
    return { role: 'agent', text: files > 0 ? `${body} [+${files} file(s)]` : body };
  }
  if (content && str(content.action)) {
    return {
      role: 'tool_call',
      request_id: str(content.requestId),
      text: `${content.action as string} ${compact(content.payload ?? {})}`,
    };
  }
  return { role: 'system', text: content ? compact(content) : row.content };
}

function openReadonly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** `kind IN (...)` restriction for the default (chat-only) depth; empty when tools are included. */
function kindClause(includeTools: boolean): string {
  return includeTools ? '' : `WHERE kind IN (${CHAT_KINDS.map((k) => `'${k}'`).join(', ')})`;
}

interface SessionRead {
  info: TranscriptSessionInfo;
  entries: TranscriptEntry[];
}

function readSession(groupId: string, session: SessionRow, includeTools: boolean, warnings: string[]): SessionRead {
  const label = sessionLabel(session.thread_id);
  const info: TranscriptSessionInfo = {
    id: session.id,
    label,
    channel: session.channel_type,
    thread_id: session.thread_id,
    status: session.status,
    last_active: session.last_active,
    in_count: 0,
    out_count: 0,
    first_ts: null,
    last_ts: null,
  };
  const entries: TranscriptEntry[] = [];
  const base = { session_id: session.id, session_label: label };

  const inPath = inboundDbPath(groupId, session.id);
  const outPath = outboundDbPath(groupId, session.id);
  const delivery = new Map<string, string>();

  if (!fs.existsSync(inPath)) {
    warnings.push(`session ${session.id}: no inbound.db (session files removed) — skipped`);
    return { info, entries };
  }

  try {
    const inDb = openReadonly(inPath);
    try {
      info.in_count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
      for (const d of inDb.prepare('SELECT message_out_id, status FROM delivered').all() as {
        message_out_id: string;
        status: string;
      }[]) {
        delivery.set(d.message_out_id, d.status);
      }
      const rows = inDb
        .prepare(
          `SELECT id, seq, kind, timestamp, status, process_after, channel_type, content FROM messages_in ${kindClause(includeTools)} ORDER BY seq`,
        )
        .all() as MessageRow[];
      for (const row of rows) {
        entries.push({
          ...base,
          ...renderInbound(row),
          ts: toIsoUtc(row.timestamp),
          channel: row.channel_type ?? session.channel_type,
          direction: 'in',
          kind: row.kind,
          id: row.id,
          seq: row.seq,
          status: row.status ?? undefined,
          due: row.process_after ? toIsoUtc(row.process_after) : undefined,
        });
      }
    } finally {
      inDb.close();
    }
  } catch (err) {
    warnings.push(`session ${session.id}: inbound.db unreadable (${err instanceof Error ? err.message : String(err)})`);
  }

  if (fs.existsSync(outPath)) {
    try {
      const outDb = openReadonly(outPath);
      try {
        info.out_count = (outDb.prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n;
        const rows = outDb
          .prepare(
            `SELECT id, seq, kind, timestamp, channel_type, in_reply_to, content FROM messages_out ${kindClause(includeTools)} ORDER BY seq`,
          )
          .all() as MessageRow[];
        for (const row of rows) {
          const isChat = CHAT_KINDS.includes(row.kind);
          entries.push({
            ...base,
            ...renderOutbound(row),
            ts: toIsoUtc(row.timestamp),
            channel: row.channel_type ?? session.channel_type,
            direction: 'out',
            kind: row.kind,
            id: row.id,
            seq: row.seq,
            status: isChat ? (delivery.get(row.id) ?? 'pending') : undefined,
            in_reply_to: row.in_reply_to ?? undefined,
          });
        }
      } finally {
        outDb.close();
      }
    } catch (err) {
      warnings.push(
        `session ${session.id}: outbound.db unreadable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // Inbound and outbound share one seq space per session, so seq is the true
  // in-session order (timestamps differ in resolution between the two DBs).
  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (entries.length > 0) {
    info.first_ts = entries[0].ts;
    info.last_ts = entries[entries.length - 1].ts;
  }
  return { info, entries };
}

/** Interleave per-session streams by timestamp while preserving each session's own order. */
function mergeBySessionOrder(streams: TranscriptEntry[][]): TranscriptEntry[] {
  const cursors = streams.map(() => 0);
  const merged: TranscriptEntry[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < streams.length; i++) {
      if (cursors[i] >= streams[i].length) continue;
      if (pick === -1 || streams[i][cursors[i]].ts < streams[pick][cursors[pick]].ts) pick = i;
    }
    if (pick === -1) return merged;
    merged.push(streams[pick][cursors[pick]++]);
  }
}

/**
 * Build the merged transcript for one agent group. `centralDb` is the central
 * app DB (sessions / agent_groups / messaging_groups); only SELECTs are issued.
 */
export function buildTranscript(centralDb: Database.Database, opts: TranscriptOptions = {}): Transcript {
  const now = opts.now ?? Date.now();
  const warnings: string[] = [];
  const result: Transcript = {
    generatedAt: new Date(now).toISOString(),
    group: null,
    sessions: [],
    entries: [],
    omitted: 0,
    warnings,
  };

  const groupKey = opts.group ?? DEFAULT_TRANSCRIPT_GROUP;
  const group = centralDb
    .prepare('SELECT id, folder, name FROM agent_groups WHERE folder = ? OR id = ? LIMIT 1')
    .get(groupKey, groupKey) as { id: string; folder: string; name: string } | undefined;
  if (!group) {
    warnings.push(`agent group "${groupKey}" not found (pass --group <folder|id>)`);
    return result;
  }
  result.group = group;

  let since: number | null = null;
  let until: number | null = null;
  if (opts.since !== undefined) {
    since = parseBound(opts.since, now);
    if (since === null)
      warnings.push(`--since "${opts.since}" not understood (ISO timestamp or 30m / 24h / 7d) — ignored`);
  }
  if (opts.until !== undefined) {
    until = parseBound(opts.until, now);
    if (until === null)
      warnings.push(`--until "${opts.until}" not understood (ISO timestamp or 30m / 24h / 7d) — ignored`);
  }

  let sessions = centralDb
    .prepare(
      `SELECT s.id, s.thread_id, s.status, s.last_active, mg.channel_type
         FROM sessions s
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
        WHERE s.agent_group_id = ?
        ORDER BY s.created_at`,
    )
    .all(group.id) as SessionRow[];
  if (opts.session) {
    sessions = sessions.filter((s) => s.id === opts.session);
    if (sessions.length === 0) warnings.push(`session "${opts.session}" not found in group ${group.folder}`);
  }

  const streams: TranscriptEntry[][] = [];
  for (const session of sessions) {
    const read = readSession(group.id, session, opts.includeTools === true, warnings);
    const filtered = read.entries.filter((e) => {
      if (opts.channel && e.channel !== opts.channel) return false;
      const ms = Date.parse(e.ts);
      if (since !== null && !(ms >= since)) return false;
      if (until !== null && !(ms <= until)) return false;
      return true;
    });
    if (opts.channel && read.info.channel !== opts.channel && filtered.length === 0) continue;
    result.sessions.push(read.info);
    streams.push(filtered);
  }

  const merged = mergeBySessionOrder(streams);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 0;
  if (limit && merged.length > limit) {
    result.omitted = merged.length - limit;
    result.entries = merged.slice(-limit);
  } else {
    result.entries = merged;
  }
  return result;
}
