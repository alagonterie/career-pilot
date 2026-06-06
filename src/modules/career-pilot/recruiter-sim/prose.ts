/**
 * Recruiter-sim prose adapter (Sub-milestone 9.3b, STRATEGY.md §24.40 D2).
 *
 * Haiku enriches the deterministic backbone body into more natural recruiter/ATS
 * prose — but it is strictly OPTIONAL. With no PORTKEY_API_KEY, under
 * PORTKEY_BYPASS, over the sim budget, or on any failure, the deterministic body
 * is used verbatim. The engine never hard-depends on the model (boilerplate ATS
 * email is realistic on its own; Haiku just adds variety).
 *
 * Routes through the locked LLM gateway — Portkey's Model Catalog — exactly as
 * the rest of the system's LLM does: a host fetch to api.portkey.ai
 * /v1/chat/completions with the AI-Provider slug in the model field
 * (`@<provider>/claude-haiku-4-5`) + the host PORTKEY_API_KEY. Host-side Portkey
 * is sanctioned (the host carries the key via the systemd EnvironmentFile
 * drop-in; the /live analytics panel uses the same key), and this puts the sim's
 * spend in Portkey's observability. (Gotcha learned at build: the catalog slug
 * goes in the MODEL field as `@provider/model`, NOT an `x-portkey-provider`
 * header — that header returns 400 "Invalid provider passed".)
 */
import { log } from '../../../log.js';
import { buildPortkeyMetadata } from '../../../portkey.js';
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
  out = out.replace(/^subject:.*$/im, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  if (out.length < 20) throw new Error('prose completion too short');
  return out.slice(0, 1500);
}

async function callHaiku(prompt: string, traceId?: string): Promise<string> {
  const base = process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1';
  const provider = process.env.PORTKEY_AI_PROVIDER || 'anthropic-default';
  // Observability headers (§24.46): tag the surface + group the application's
  // emails into one trace. No PII (env / surface / app-id slugs only).
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-portkey-api-key': process.env.PORTKEY_API_KEY as string,
  };
  const metadata = buildPortkeyMetadata({ environment: process.env.ENVIRONMENT, surface: 'recruiter-sim' });
  if (Object.keys(metadata).length > 0) headers['x-portkey-metadata'] = JSON.stringify(metadata);
  if (traceId) headers['x-portkey-trace-id'] = traceId;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: `@${provider}/${HAIKU_MODEL}`,
      max_tokens: 320,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`portkey HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('portkey: no content in completion');
  return sanitizeProse(text);
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
    const body = await callHaiku(prompt, traceId);
    return { body, usedLlm: true, estCostUsd: HAIKU_EST_COST_USD };
  } catch (err) {
    log.warn('recruiter-sim: prose enrich failed, using deterministic body', { err });
    return deterministic;
  }
}
