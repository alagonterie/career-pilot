/**
 * src/modules/portal/simulator.ts — public sandbox simulator orchestration.
 *
 * Handles `POST /api/sandbox/start` flow:
 *   1. Validate Turnstile token (server-side siteverify with idempotency_key)
 *   2. Check Durable Object daily caps (per-IP + global $ budget)
 *   3. Spawn a career-pilot-sandbox session via NanoClaw's session manager
 *      (session_mode='per-thread' — visitor gets fresh isolated session)
 *   4. Return a session ID; the frontend opens an SSE to /api/simulator/:id/stream
 *
 * Cache: successful runs are persisted to simulator_runs (migration 107) with
 * 30-day TTL. /simulator falls back to a recent cached run when the sandbox
 * is rate-limited / budget-exhausted / disabled.
 *
 * See STRATEGY.md §7 + PORTAL.md §5.4 (simulator UX).
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 7 (STRATEGY.md §V).
 */
export {};
