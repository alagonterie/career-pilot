/**
 * Career-pilot system-action round-trip helper (container side).
 *
 * Career-pilot MCP tools that read or write the host's central `data/v2.db`
 * cannot reach it directly — the host's long-lived WAL connection precludes
 * cross-mount sharing. The contract (per STRATEGY.md §6.1) is:
 *
 *   1. Write a `kind: 'system'` row to `outbound.db` via `writeMessageOut`.
 *      Content JSON: `{ action: 'career_pilot.<name>', requestId, payload }`.
 *   2. Host's delivery sweep dispatches to the registered handler
 *      (`src/modules/career-pilot/actions.ts` — `registerDeliveryAction`).
 *      Handler does the DB op and writes a response back to `inbound.db`
 *      with `kind: 'system'`, `trigger: 0`, content
 *      `{ type: 'career_pilot_response', requestId, frame: { ok, data | error } }`.
 *   3. We poll `inbound.db` for the response, ack it via `processing_ack`,
 *      and return the parsed frame.
 *
 * Mirrors the `ask_user_question` and `cli_request` round-trip pattern.
 */
import { openInboundDb, getOutboundDb } from '../db/connection.js';
import { markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';

function log(msg: string): void {
  console.error(`[career-pilot] ${msg}`);
}

function generateRequestId(): string {
  return `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ActionResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * Send a career_pilot action and await the host's response. Default timeout
 * is 10s — DB ops should complete in tens of ms; longer suggests a real
 * problem the agent should know about rather than silently absorb.
 *
 * Action names follow the pattern `career_pilot.<verb>` (e.g.
 * `career_pilot.update_application`). The host's handler registry is keyed
 * on this exact string.
 */
export async function sendAction<T = unknown>(
  action: string,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<ActionResponse<T>> {
  const requestId = generateRequestId();
  const r = getSessionRouting();

  writeMessageOut({
    id: requestId,
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, requestId, payload }),
  });

  log(`sendAction: ${action} (${requestId})`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findActionResponse(requestId);
    if (response) {
      markCompleted([response.id]);
      try {
        const parsed = JSON.parse(response.content) as {
          type: string;
          requestId: string;
          frame: ActionResponse<T>;
        };
        if (parsed.type !== 'career_pilot_response') {
          return {
            ok: false,
            error: { code: 'BAD_RESPONSE', message: `unexpected response type "${parsed.type}"` },
          };
        }
        return parsed.frame;
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'PARSE_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }
    await sleep(250);
  }

  log(`sendAction timeout: ${action} (${requestId})`);
  return {
    ok: false,
    error: { code: 'TIMEOUT', message: `host did not respond within ${timeoutMs}ms` },
  };
}

interface MessageInRow {
  id: string;
  content: string;
}

/**
 * Look for a career_pilot_response with matching requestId in inbound.db.
 * Mirrors `findQuestionResponse` but keyed on our own requestId field.
 *
 * Opens a fresh handle each call so cross-mount page-cache staleness doesn't
 * hide a response that was just written by the host.
 */
function findActionResponse(requestId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();
  try {
    const row = inbound
      .prepare(
        "SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?",
      )
      .get(`%"requestId":"${requestId}"%`) as MessageInRow | undefined;
    if (!row) return undefined;
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(row.id);
    if (acked) return undefined;
    return row;
  } finally {
    inbound.close();
  }
}
