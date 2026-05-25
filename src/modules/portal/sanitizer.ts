/**
 * src/modules/portal/sanitizer.ts — three-pass sanitization pipeline.
 *
 * Pass 1: deterministic regex (emails, phones, SSN-like, monetary, addresses,
 *         URLs with PII)
 * Pass 2: company name + alias replacement (loads applications WHERE
 *         public_state != 'public', replaces with [REDACTED:<obfuscated_label>])
 * Pass 3: optional Haiku LLM review for context-sensitive leakage. If flagged
 *         high-risk, returns null — caller drops the event from the public
 *         mirror and notifies the owner.
 *
 * Used by:
 *   - public-audit.ts post-write hook on funnel_events / applications
 *   - api.ts /api/activity rendering
 *   - delivery.ts before any portal-channel SSE output
 *
 * See STRATEGY.md §9 for the full pseudocode.
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 3 (STRATEGY.md §V).
 */
export async function sanitize(
  _raw: string,
  _opts?: { application_id?: string },
): Promise<string | null> {
  throw new Error('sanitizer.sanitize: not yet implemented (Phase 3)');
}
