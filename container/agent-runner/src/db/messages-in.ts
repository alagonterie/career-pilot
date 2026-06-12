/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { openInboundDb, getOutboundDb } from './connection.js';

// Cache whether inbound.db has the on_wake column (added in v2.0.48).
// The container opens inbound.db read-only, so it can't ALTER —
// gracefully degrade when running against an older session DB.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Returns the most recent `MAX_MESSAGES_PER_PROMPT` pending rows in
 * chronological order, regardless of their `trigger` flag: accumulated
 * context (trigger=0) rides along with the wake-eligible rows so the agent
 * sees the prior context it missed. Host's countDueMessages gates waking on
 * trigger=1 separately (see src/db/session-db.ts).
 *
 * The ack filter MUST run before the newest-N cap (fork deviation, STRATEGY.md
 * §24.67): with `LIMIT N` in the SQL, ≥N stale-but-pending rows sitting above
 * an older due row hide it from every prompt forever — the §24.66 starvation
 * outage. Pending rows are bounded in practice (the host's orphan sweep keeps
 * the queue clear), so fetching them all before capping is cheap.
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const hasOnWake = hasOnWakeColumn(inbound);
    const onWakeFilter = hasOnWake ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const stmt = inbound.prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         ${onWakeFilter}
       ORDER BY seq DESC`,
    );
    const pending = (hasOnWake ? stmt.all(isFirstPoll ? 1 : 0) : stmt.all()) as MessageInRow[];

    if (pending.length === 0) return [];

    // Filter out messages already acknowledged in outbound.db
    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );

    // Cap AFTER the ack filter, then reverse: we fetched DESC so the slice is
    // the most recent N unconsumed rows, and the agent should see them in
    // chronological order (oldest first).
    return pending
      .filter((m) => !ackedIds.has(m.id))
      .slice(0, getMaxMessagesPerPrompt())
      .reverse();
  } finally {
    inbound.close();
  }
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', datetime('now'))",
    )
    .run(id);
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const response = inbound
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
      .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

    if (!response) return undefined;

    // Check it hasn't been acked already
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
    if (acked) return undefined;

    return response;
  } finally {
    inbound.close();
  }
}

