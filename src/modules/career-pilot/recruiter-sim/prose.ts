/**
 * Recruiter-sim prose adapter (Sub-milestone 9.3b, STRATEGY.md §24.40 D2).
 *
 * Haiku enriches the deterministic backbone body into more natural recruiter/ATS
 * prose — but it is strictly OPTIONAL. With no PORTKEY_API_KEY, under
 * PORTKEY_BYPASS, over the sim budget, or on any failure, the deterministic body
 * is used verbatim. The engine never hard-depends on the model (boilerplate ATS
 * email is realistic on its own; Haiku just adds variety).
 *
 * Host-side Portkey is sanctioned here: unlike the Phase-3.1 NO_AUTH finding
 * (the host had no key then), the host now carries PORTKEY_API_KEY via the
 * systemd EnvironmentFile drop-in. LLM goes through Portkey (Anthropic format),
 * which is separate from OneCLI (Google/non-LLM creds) — so this is a direct
 * host fetch to api.portkey.ai, not a gateway-proxied call.
 */
import { log } from '../../../log.js';
import type { InjectEmailIntent } from './types.js';

const HAIKU_MODEL = 'claude-haiku-4-5';
/** Conservative flat per-call estimate (a ~200-tok prompt + ~150-tok output on Haiku). */
export const HAIKU_EST_COST_USD = 0.002;

export interface ProseResult {
  body: string;
  usedLlm: boolean;
  estCostUsd: number;
}

/** True when a Portkey enrichment call is even possible (key present, not bypassed). */
export function portkeyConfigured(): boolean {
  return !!process.env.PORTKEY_API_KEY && process.env.PORTKEY_BYPASS !== 'true';
}

/**
 * Tidy a model completion into a usable plain-text email body: trim, drop a
 * stray "Subject:" line or surrounding quotes, and cap the length. Throws when
 * the result is implausibly short so the caller falls back to the backbone.
 */
export function sanitizeProse(text: string): string {
  let out = text.trim();
  // Strip a leading "Subject: …" line if the model added one.
  out = out.replace(/^subject:.*$/im, '').trim();
  // Strip a single layer of surrounding quotes.
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  if (out.length < 20) throw new Error('prose completion too short');
  return out.slice(0, 1500);
}

async function callHaiku(prompt: string): Promise<string> {
  const base = process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1';
  const provider = process.env.PORTKEY_AI_PROVIDER || 'anthropic-default';
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-portkey-api-key': process.env.PORTKEY_API_KEY as string,
      'x-portkey-provider': provider,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 320,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`portkey HTTP ${res.status}`);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = data.content?.find((b) => b.type === 'text')?.text ?? data.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('portkey: no text in completion');
  return sanitizeProse(text);
}

/**
 * Return the email body for an intent: the Haiku-enriched version when Portkey
 * is configured AND there is budget left, otherwise the deterministic backbone.
 * Never throws.
 */
export async function enrichBody(intent: InjectEmailIntent, budgetRemainingUsd: number): Promise<ProseResult> {
  const deterministic: ProseResult = { body: intent.deterministicBody, usedLlm: false, estCostUsd: 0 };
  if (!portkeyConfigured() || budgetRemainingUsd < HAIKU_EST_COST_USD) return deterministic;
  try {
    const prompt = `${intent.prosePrompt}\n\nDraft to rewrite (keep the facts, improve the wording):\n${intent.deterministicBody}`;
    const body = await callHaiku(prompt);
    return { body, usedLlm: true, estCostUsd: HAIKU_EST_COST_USD };
  } catch (err) {
    log.warn('recruiter-sim: prose enrich failed, using deterministic body', { err });
    return deterministic;
  }
}
