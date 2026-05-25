/**
 * src/modules/portal/sse-broadcaster.ts — Server-Sent Events infrastructure.
 *
 * Maintains a registry of active SSE connections keyed by topic (e.g.,
 * `activity`, `simulator:<session_id>`). Used by api.ts to push new
 * public_audit_trail rows and sandbox session output to connected clients.
 *
 * Keep-alives every 15s (Cloudflare Tunnel default idle timeout is generous
 * but a heartbeat is cheap insurance).
 *
 * See AGENT_SDK_PATTERNS.md §9 for the SSE streaming patterns.
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 4 (STRATEGY.md §V).
 */
export {};
