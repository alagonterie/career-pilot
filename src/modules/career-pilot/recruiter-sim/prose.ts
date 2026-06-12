/**
 * Recruiter-sim prose adapter (Sub-milestone 9.3b, STRATEGY.md §24.40 D2).
 *
 * Haiku enriches the deterministic backbone body into more natural recruiter/ATS
 * prose — but it is strictly OPTIONAL. With no PORTKEY_API_KEY, under
 * PORTKEY_BYPASS, over the sim budget, or on any failure, the deterministic body
 * is used verbatim. The engine never hard-depends on the model (boilerplate ATS
 * email is realistic on its own; Haiku just adds variety).
 *
 * The Portkey call itself lives in the shared host helper (src/llm-fetch.ts,
 * §24.68 D5), which records a request_telemetry row on both outcomes and reads
 * the response usage — so `estCostUsd` is the ACTUAL priced cost when usage is
 * available, falling back to the flat estimate. The flat HAIKU_EST_COST_USD
 * stays as the PRE-call budget gate (actuals are unknowable before the call).
 */
import { callPortkeyChat, portkeyConfigured } from '../../../llm-fetch.js';
import { log } from '../../../log.js';
import type { InjectEmailIntent } from './types.js';

export { portkeyConfigured };

const HAIKU_MODEL = 'claude-haiku-4-5';
/** Conservative flat per-call estimate (a ~200-tok prompt + ~150-tok output on Haiku). */
export const HAIKU_EST_COST_USD = 0.002;

export interface ProseResult {
  body: string;
  usedLlm: boolean;
  estCostUsd: number;
}

/**
 * Tidy a model completion into a usable plain-text email body: trim, drop a
 * stray "Subject:" line or surrounding quotes, and cap the length. Throws when
 * the result is implausibly short so the caller falls back to the backbone.
 */
export function sanitizeProse(text: string): string {
  let out = text.trim();
  out = out.replace(/^subject:.*$/im, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  if (out.length < 20) throw new Error('prose completion too short');
  return out.slice(0, 1500);
}

/**
 * Return the email body for an intent: the Haiku-enriched version when Portkey
 * is configured AND there is budget left, otherwise the deterministic backbone.
 * Never throws.
 */
export async function enrichBody(
  intent: InjectEmailIntent,
  budgetRemainingUsd: number,
  traceId?: string,
): Promise<ProseResult> {
  const deterministic: ProseResult = { body: intent.deterministicBody, usedLlm: false, estCostUsd: 0 };
  if (!portkeyConfigured() || budgetRemainingUsd < HAIKU_EST_COST_USD) return deterministic;
  try {
    const prompt = `${intent.prosePrompt}\n\nDraft to rewrite (keep the facts, improve the wording):\n${intent.deterministicBody}`;
    const result = await callPortkeyChat({
      surface: 'recruiter-sim-prose',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 320,
      model: HAIKU_MODEL,
      traceId,
    });
    const body = sanitizeProse(result.text);
    const estCostUsd = result.costMicrousd != null ? result.costMicrousd / 1_000_000 : HAIKU_EST_COST_USD;
    return { body, usedLlm: true, estCostUsd };
  } catch (err) {
    log.warn('recruiter-sim: prose enrich failed, using deterministic body', { err });
    return deterministic;
  }
}
