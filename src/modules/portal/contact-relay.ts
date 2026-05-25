/**
 * src/modules/portal/contact-relay.ts — /api/contact handler.
 *
 * POST /api/contact from the public site is served by the Cloudflare Worker
 * (Turnstile-protected). The Worker forwards verified submissions to this
 * handler, which:
 *   1. Sanitizes the submitted message via sanitizer.ts (defensive — visitor
 *      may have pasted PII)
 *   2. Writes a system message to the owner's Telegram session via NanoClaw's
 *      messaging stack
 *   3. Returns { ok: true } to the Worker for the response to the visitor
 *
 * Rate limiting upstream (Workers RL: 5 submits/IP/hour). No DB persistence
 * by default — contact submissions live only in the owner's Telegram history.
 *
 * See PORTAL.md §5.7 (contact form UX) + CLOUDFLARE_PATTERNS.md §2 (Turnstile).
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 8 (STRATEGY.md §V).
 */
export {};
