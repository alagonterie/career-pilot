/**
 * src/portkey.ts — shared Portkey observability header builders.
 *
 * Portkey segments its dashboard on `x-portkey-metadata` (a JSON object of
 * string values, ≤128 chars each) and groups related requests into one trace
 * via `x-portkey-trace-id`. Both are observability-only — plain HTTP headers,
 * no SDK — and carry NO PII (env / group / session slugs only, never names or
 * emails). Used by the host-side LLM fetches (recruiter-sim prose,
 * win-confidence) and, mirrored into `ANTHROPIC_CUSTOM_HEADERS`, the
 * agent-runtime provider shim (providers/claude.ts).
 *
 * See STRATEGY.md §24.46.
 */

/** Portkey caps each metadata value at 128 chars (longer values are rejected). */
export const PORTKEY_METADATA_MAX_VALUE_LEN = 128;

export interface PortkeyMetadataFields {
  /** Deploy environment — `dev` / `prod`. */
  environment?: string;
  /** Agent group folder — separates owner from the public sandbox spend. */
  agent_group?: string;
  /** Session id — ties a dashboard row back to a session (also the trace id). */
  session_id?: string;
  /** Host-side call site — `recruiter-sim` / `win-confidence` — vs the agent runtime. */
  surface?: string;
}

/**
 * Build a Portkey metadata object from the given fields: only present, non-empty
 * string values, each clamped to the 128-char limit. Returns `{}` when nothing
 * is set, so callers can skip the header entirely in that case.
 */
export function buildPortkeyMetadata(fields: PortkeyMetadataFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value.slice(0, PORTKEY_METADATA_MAX_VALUE_LEN);
    }
  }
  return out;
}
