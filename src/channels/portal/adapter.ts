/**
 * src/channels/portal/adapter.ts — portal channel adapter (NanoClaw channel).
 *
 * Conforms to NanoClaw's channel interface but transport is HTTP + SSE
 * instead of bot polling. Distinct from the Telegram channel (`/add-telegram`
 * skill) which is bot-polling.
 *
 * Inbound: POST /api/sandbox/start (from frontend) → portal/api.ts → this
 *   adapter's submit() → creates a NanoClaw session (session_mode='per-thread')
 *   and writes the initial `messages_in` row of `kind='chat'`.
 *
 * Outbound: registry of active SSE connections keyed by session_id. When
 *   delivery.ts calls this adapter's sendMessage(), it pushes a formatted
 *   event into the matching SSE stream via sse-output.ts.
 *
 * Session lifecycle:
 *   - 30s idle timeout on the sandbox container
 *   - 5min hard wall on total session duration (safety)
 *   - Session torn down after final `messages_out` of `kind='task'`
 *
 * See STRATEGY.md §7 ("portal channel (custom)").
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 4 (STRATEGY.md §V).
 */
export {};
