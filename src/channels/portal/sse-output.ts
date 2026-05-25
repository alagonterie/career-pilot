/**
 * src/channels/portal/sse-output.ts — outbound SSE delivery for portal channel.
 *
 * Receives formatted messages from adapter.ts and pushes them into the
 * matching SSE connection (registered by session_id in sse-broadcaster.ts).
 * Each push includes:
 *   - event: 'chat' | 'task' | 'system' (NanoClaw kind)
 *   - data: { role, content, ts, sanitized? }
 *
 * Sanitization happens BEFORE this layer — caller is responsible for passing
 * sanitized content. Sandbox sessions don't strictly need sanitization since
 * they're already isolated, but the simulator panel still applies cosmetic
 * redaction (visitor's pasted JD echoed back without their email, etc.).
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 4 (STRATEGY.md §V).
 */
export {};
