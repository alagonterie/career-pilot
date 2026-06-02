/**
 * src/modules/portal/sse-broadcaster.ts — Server-Sent Events infrastructure.
 *
 * Sub-milestone 5.2 (STRATEGY.md §24.16) — the live `activity` stream behind
 * the portal's `● live` indicator + the `/live` trace stream.
 *
 * Poll-based tail (locked in §24.16): the broadcaster learns of new
 * public_audit_trail rows by polling by the monotonic `seq` cursor on an
 * interval — NOT by event hooks from the writers. This keeps SSE decoupled
 * from mirrorFunnelEvent/handleRecordProgress (the broadcaster only reads),
 * stays consistent with the host's poll-everywhere model, and handles the
 * §24.14 resanitize delete+re-insert for free. The tail timer is client-gated:
 * it runs only while ≥1 client is connected, and is `.unref()`'d so it never
 * holds the process open.
 *
 * Each client carries its own `lastSeq` watermark, so backlog replay (on
 * Last-Event-ID / ?since resume) and the live tail dovetail with no gap or
 * duplicate. Frame: `id: <seq>\ndata: <json row>\n\n`; keep-alive `: ka\n\n`.
 *
 * Topic-keyed by design (5.2 uses `activity`; `simulator:<id>` lands in 5.5).
 */
import type http from 'http';

import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

const DEFAULT_TAIL_INTERVAL_MS = 1000;
const DEFAULT_KEEPALIVE_MS = 15_000;

interface ActivityClient {
  res: http.ServerResponse;
  lastSeq: number;
  lastWriteAt: number;
}

interface AuditRow {
  seq: number;
  ts: string;
  category: string;
  agent_name: string | null;
  proactive: number;
  application_ref: string | null;
  model_used: string | null;
  tokens: number | null;
  cost_cents: number | null;
  cache_hit: number;
  latency_ms: number | null;
  summary: string;
}

const SELECT_COLS =
  'seq, ts, category, agent_name, proactive, application_ref, model_used, tokens, cost_cents, cache_hit, latency_ms, summary';

const activityClients = new Set<ActivityClient>();
let tailTimer: NodeJS.Timeout | null = null;
let keepaliveMs = DEFAULT_KEEPALIVE_MS;

// ── DB reads ────────────────────────────────────────────────────────────────

function currentMaxSeq(): number {
  try {
    const row = getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM public_audit_trail').get() as { m: number };
    return row.m ?? 0;
  } catch (err) {
    log.error('sse currentMaxSeq failed', { err });
    return 0;
  }
}

function rowsSince(seq: number): AuditRow[] {
  try {
    return getDb()
      .prepare(`SELECT ${SELECT_COLS} FROM public_audit_trail WHERE seq > ? ORDER BY seq ASC`)
      .all(seq) as AuditRow[];
  } catch (err) {
    log.error('sse rowsSince failed', { err });
    return [];
  }
}

// ── frame writers ────────────────────────────────────────────────────────

function writeEvent(client: ActivityClient, row: AuditRow): void {
  try {
    client.res.write(`id: ${row.seq}\ndata: ${JSON.stringify(row)}\n\n`);
    client.lastSeq = row.seq;
    client.lastWriteAt = Date.now();
  } catch (err) {
    log.warn('sse writeEvent failed; dropping client', { err });
    activityClients.delete(client);
    maybeStopTail();
  }
}

// ── tail loop (client-gated) ───────────────────────────────────────────────

function tick(): void {
  if (activityClients.size === 0) {
    maybeStopTail();
    return;
  }

  let minSeq = Infinity;
  for (const c of activityClients) minSeq = Math.min(minSeq, c.lastSeq);
  if (!Number.isFinite(minSeq)) minSeq = 0;

  const rows = rowsSince(minSeq);
  const now = Date.now();

  for (const c of activityClients) {
    let wrote = false;
    for (const row of rows) {
      if (row.seq > c.lastSeq) {
        writeEvent(c, row);
        wrote = true;
      }
    }
    if (!wrote && now - c.lastWriteAt >= keepaliveMs) {
      try {
        c.res.write(': ka\n\n');
        c.lastWriteAt = now;
      } catch {
        activityClients.delete(c);
      }
    }
  }

  maybeStopTail();
}

function ensureTail(): void {
  if (tailTimer) return;
  let intervalMs = DEFAULT_TAIL_INTERVAL_MS;
  try {
    intervalMs = getConfig<number>(getDb(), 'portal_sse_tail_interval_ms', DEFAULT_TAIL_INTERVAL_MS);
    keepaliveMs = getConfig<number>(getDb(), 'portal_sse_keepalive_ms', DEFAULT_KEEPALIVE_MS);
  } catch {
    intervalMs = DEFAULT_TAIL_INTERVAL_MS;
    keepaliveMs = DEFAULT_KEEPALIVE_MS;
  }
  tailTimer = setInterval(tick, Math.max(50, intervalMs));
  if (typeof tailTimer.unref === 'function') tailTimer.unref();
  log.info('sse activity tail started', { intervalMs, keepaliveMs });
}

function maybeStopTail(): void {
  if (tailTimer && activityClients.size === 0) {
    clearInterval(tailTimer);
    tailTimer = null;
    log.info('sse activity tail stopped (no clients)');
  }
}

// ── public API ──────────────────────────────────────────────────────────

/**
 * Register an SSE client on the `activity` topic. If `cursor` is non-null the
 * backlog `seq > cursor` is replayed immediately (resume); otherwise the
 * client starts live from the current max seq (no history dump). The caller
 * must already have written the SSE response headers.
 */
export function addActivityClient(res: http.ServerResponse, cursor: number | null): void {
  const client: ActivityClient = {
    res,
    lastSeq: cursor != null && cursor >= 0 ? cursor : currentMaxSeq(),
    lastWriteAt: Date.now(),
  };
  if (cursor != null && cursor >= 0) {
    for (const row of rowsSince(cursor)) writeEvent(client, row);
  }
  activityClients.add(client);
  ensureTail();
}

/** Deregister a client (call from the request's `close` event). */
export function removeActivityClient(res: http.ServerResponse): void {
  for (const c of activityClients) {
    if (c.res === res) {
      activityClients.delete(c);
      break;
    }
  }
  maybeStopTail();
}

/** Stop the tail and end every open stream. Called from stopPortalApi/shutdown. */
export function stopBroadcaster(): void {
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = null;
  }
  for (const c of activityClients) {
    try {
      c.res.end();
    } catch {
      // already closed
    }
  }
  activityClients.clear();
  endAllSimulatorClients();
  log.info('sse broadcaster stopped');
}

// ── simulator topic (Sub-milestone 5.5b, §24.20) ──────────────────────────
//
// Push-based (unlike the poll-based `activity` tail): the portal channel
// adapter calls pushSimulatorEvent() from delivery.ts as the sandbox session's
// trace/chat/task outbound rows drain. Keyed by run id (= the session threadId).
// A run is short-lived; there is no backlog replay (the visitor watches live)
// and no tail timer.

const simulatorClients = new Map<string, Set<http.ServerResponse>>();

/**
 * Register an SSE client for a simulator run. The caller must already have
 * written the event-stream response headers. No backlog is replayed — the
 * visitor watches the run live from connect.
 */
export function addSimulatorClient(runId: string, res: http.ServerResponse): void {
  let set = simulatorClients.get(runId);
  if (!set) {
    set = new Set();
    simulatorClients.set(runId, set);
  }
  set.add(res);
  // Establish the stream immediately (Node otherwise buffers until first write).
  try {
    res.write(': open\n\n');
  } catch {
    set.delete(res);
  }
}

/**
 * Push one event to every client watching `runId`. `event` is the SSE event
 * name (the outbound `kind` — 'trace' | 'chat' | 'task'); `payload` is the
 * already-parsed JSON body. No-op when nobody is watching that run.
 */
export function pushSimulatorEvent(runId: string, event: string, payload: unknown): void {
  const set = simulatorClients.get(runId);
  if (!set || set.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

/** Deregister a simulator client (call from the request's `close` event). */
export function removeSimulatorClient(runId: string, res: http.ServerResponse): void {
  const set = simulatorClients.get(runId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) simulatorClients.delete(runId);
}

function endAllSimulatorClients(): void {
  for (const set of simulatorClients.values()) {
    for (const res of set) {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
  }
  simulatorClients.clear();
}

// Test seams.
export function _activityClientCount(): number {
  return activityClients.size;
}
export function _isTailRunning(): boolean {
  return tailTimer != null;
}
export function _simulatorClientCount(runId: string): number {
  return simulatorClients.get(runId)?.size ?? 0;
}
