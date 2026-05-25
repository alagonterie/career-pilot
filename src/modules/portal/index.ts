/**
 * Portal module barrel.
 *
 * The portal module is career-pilot's extension to NanoClaw: it adds the
 * public-facing Express API, the sanitization pipeline, the public_audit_trail
 * tap, the SSE infrastructure, the system-modes control plane, the
 * Portkey analytics proxy, the simulator orchestration, the contact-relay,
 * and the kill-switch control plane.
 *
 * Per STRATEGY.md §2, this module lives at src/modules/portal/ — additive,
 * non-invasive to NanoClaw upstream.
 *
 * Phase 0 status: PLACEHOLDER. Wiring to src/modules/index.ts deferred to
 * Phase 4 (when the Express API + SSE infra come online).
 */
export {};
