/**
 * src/llm-fetch.ts — the shared host-side Portkey chat-completions helper
 * (STRATEGY.md §24.68 D5).
 *
 * Replaces the three duplicated fetches (recruiter-sim prose, win-confidence,
 * sanitizer pass 3) with one path that actually reads the response `usage`
 * instead of booking flat estimates — and records a `request_telemetry` row on
 * BOTH outcomes (success with tokens/cost, failure with status/error) before
 * surfacing the error to the caller. Routes through the locked LLM gateway
 * exactly as before: a fetch to api.portkey.ai/v1/chat/completions with the
 * AI-Provider slug in the model field (`@<provider>/<model>`).
 *
 * Usage parsing is deliberately defensive: Portkey's /chat/completions is
 * OpenAI-format (`prompt_tokens`/`completion_tokens`) but the shape for
 * Anthropic models has not been verified end-to-end, so the Anthropic names
 * (`input_tokens`/`output_tokens`) are accepted too and the raw usage object is
 * kept in details_json during the observation window. Missing usage degrades to
 * null tokens — the call still succeeds.
 */
import type Database from 'better-sqlite3';

import { getDb } from './db/connection.js';
import { getConfig } from './get-config.js';
import { buildPortkeyMetadata } from './portkey.js';
import { priceTokensMicrousd, recordRequestTelemetry } from './request-telemetry.js';

export const DEFAULT_LLM_MODEL = 'claude-haiku-4-5';
/** Last-resort timeout when the central DB isn't up (defaults.json is canonical). */
const FALLBACK_TIMEOUT_MS = 20_000;

/** True when a host-side Portkey call is possible (key present, not bypassed). */
export function portkeyConfigured(): boolean {
  return !!process.env.PORTKEY_API_KEY && process.env.PORTKEY_BYPASS !== 'true';
}

export interface PortkeyChatArgs {
  /** Call-site slug for telemetry + the Portkey metadata header. */
  surface: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  maxTokens: number;
  /** Bare model name (no provider slug). Default: claude-haiku-4-5. */
  model?: string;
  /** Default: getConfig('llm_fetch_timeout_ms'). */
  timeoutMs?: number;
  traceId?: string;
}

export interface PortkeyChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface PortkeyChatResult {
  text: string;
  usage: PortkeyChatUsage;
  /** Estimated from the pricing map; null when usage or pricing is unknown. */
  costMicrousd: number | null;
  latencyMs: number;
}

interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

function asCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Accept OpenAI-format usage AND Anthropic passthrough names. Exported for tests. */
export function extractUsage(raw: unknown): PortkeyChatUsage {
  const u = (raw && typeof raw === 'object' ? raw : {}) as RawUsage;
  return {
    inputTokens: asCount(u.prompt_tokens) ?? asCount(u.input_tokens),
    outputTokens: asCount(u.completion_tokens) ?? asCount(u.output_tokens),
    cacheReadTokens: asCount(u.cache_read_input_tokens) ?? asCount(u.prompt_tokens_details?.cached_tokens),
    cacheCreationTokens: asCount(u.cache_creation_input_tokens),
  };
}

/**
 * One Portkey chat-completions call with telemetry on both outcomes. Throws on
 * any failure (HTTP error, timeout, empty completion) AFTER recording the
 * failure row — callers keep their existing catch-and-degrade behavior.
 */
export async function callPortkeyChat(args: PortkeyChatArgs): Promise<PortkeyChatResult> {
  // DB-optional: the recorder no-ops and pricing/config fall back when the
  // central DB isn't initialized (unit tests exercising callers directly).
  let db: Database.Database | null = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }
  const base = process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1';
  const provider = process.env.PORTKEY_AI_PROVIDER || 'anthropic-default';
  const model = args.model || DEFAULT_LLM_MODEL;
  const timeoutMs = args.timeoutMs ?? (db ? getConfig<number>(db, 'llm_fetch_timeout_ms') : FALLBACK_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-portkey-api-key': process.env.PORTKEY_API_KEY as string,
  };
  const metadata = buildPortkeyMetadata({ environment: process.env.ENVIRONMENT, surface: args.surface });
  if (Object.keys(metadata).length > 0) headers['x-portkey-metadata'] = JSON.stringify(metadata);
  if (args.traceId) headers['x-portkey-trace-id'] = args.traceId;

  const t0 = Date.now();
  const fail = (statusCode: number | null, error: string): never => {
    recordRequestTelemetry({
      provider: 'portkey',
      surface: args.surface,
      trafficClass: 'host',
      ok: false,
      latencyMs: Date.now() - t0,
      statusCode,
      model,
      error,
      traceId: args.traceId ?? null,
    });
    throw new Error(error);
  };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: `@${provider}/${model}`, max_tokens: args.maxTokens, messages: args.messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(null, `portkey fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) return fail(res.status, `portkey HTTP ${res.status}`);

  let data: { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return fail(res.status, 'portkey: response body is not JSON');
  }
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return fail(res.status, 'portkey: no content in completion');

  const latencyMs = Date.now() - t0;
  const usage = extractUsage(data.usage);
  const costMicrousd = db ? priceTokensMicrousd(db, model, usage) : null;
  recordRequestTelemetry({
    provider: 'portkey',
    surface: args.surface,
    trafficClass: 'host',
    ok: true,
    latencyMs,
    statusCode: res.status,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costMicrousd,
    traceId: args.traceId ?? null,
    // Raw usage kept while the /chat/completions shape for Anthropic models is
    // under observation; drop once verified on the box.
    details: data.usage !== undefined ? { raw_usage: data.usage } : null,
  });
  return { text, usage, costMicrousd, latencyMs };
}
