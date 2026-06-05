/**
 * Recruiter-sim prose adapter (Sub-milestone 9.3b, STRATEGY.md §24.40 D2).
 *
 * Haiku enriches the deterministic backbone body into more natural recruiter/ATS
 * prose — but it is strictly OPTIONAL. Outside ENVIRONMENT=dev, over the sim
 * budget, or on any failure, the deterministic body is used verbatim. The engine
 * never hard-depends on the model (boilerplate ATS email is realistic on its
 * own; Haiku just adds variety).
 *
 * The call goes through the SAME OneCLI gateway path as the sim's Gmail
 * injection: `onecli run -- curl` to the Anthropic Messages API, with OneCLI
 * MITM-injecting the `x-api-key` from its `Anthropic` secret. Going gateway →
 * Anthropic (vs a direct Portkey fetch) keeps one credential path for the whole
 * fixture and avoids depending on a Portkey Model-Catalog provider slug.
 */
import { log } from '../../../log.js';
import { gatewayCurl } from './inject.js';
import type { InjectEmailIntent } from './types.js';

const HAIKU_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Conservative flat per-call estimate (a ~200-tok prompt + ~150-tok output on Haiku). */
export const HAIKU_EST_COST_USD = 0.002;

export interface ProseResult {
  body: string;
  usedLlm: boolean;
  estCostUsd: number;
}

/** Enrichment is attempted only on the dev stack (the sim's only home). */
export function enrichmentEnabled(): boolean {
  return process.env.ENVIRONMENT === 'dev';
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

async function callHaiku(prompt: string): Promise<string> {
  const res = await gatewayCurl(
    'POST',
    ANTHROPIC_MESSAGES_URL,
    { model: HAIKU_MODEL, max_tokens: 320, messages: [{ role: 'user', content: prompt }] },
    { 'anthropic-version': '2023-06-01' },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`anthropic HTTP ${res.status}: ${res.raw.slice(0, 160)}`);
  }
  const content = res.json?.content as Array<{ type?: string; text?: string }> | undefined;
  const text = content?.find((b) => b.type === 'text')?.text ?? content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('anthropic: no text in completion');
  return sanitizeProse(text);
}

/**
 * Return the email body for an intent: the Haiku-enriched version when on the
 * dev stack AND there is budget left, otherwise the deterministic backbone.
 * Never throws.
 */
export async function enrichBody(intent: InjectEmailIntent, budgetRemainingUsd: number): Promise<ProseResult> {
  const deterministic: ProseResult = { body: intent.deterministicBody, usedLlm: false, estCostUsd: 0 };
  if (!enrichmentEnabled() || budgetRemainingUsd < HAIKU_EST_COST_USD) return deterministic;
  try {
    const prompt = `${intent.prosePrompt}\n\nDraft to rewrite (keep the facts, improve the wording):\n${intent.deterministicBody}`;
    const body = await callHaiku(prompt);
    return { body, usedLlm: true, estCostUsd: HAIKU_EST_COST_USD };
  } catch (err) {
    log.warn('recruiter-sim: prose enrich failed, using deterministic body', { err });
    return deterministic;
  }
}
