/**
 * src/request-telemetry.ts — the per-request telemetry recorder (STRATEGY.md §24.68).
 *
 * One row per outbound API request at every choke point our own code owns —
 * success AND failure. The table is the durable answer to "is X failing / how
 * long / how often" that the §24.66 incident showed log lines cannot give.
 * Top-level (not a module) because choke points span core (`src/scrape-jobs`),
 * the portal module (sanitizer pass 3), and career-pilot.
 *
 * Contract: `recordRequestTelemetry` NEVER throws into the calling path — a
 * telemetry failure must not break the request it observes. Honors the
 * `telemetry_capture` kill switch (the same one that gates the public per-turn
 * rows). Rows are pruned by the host-sweep maintenance step
 * (`request_telemetry_retention_days`).
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from './db/connection.js';
import { getConfig } from './get-config.js';
import { log } from './log.js';

export type TrafficClass = 'ops' | 'chat' | 'sandbox' | 'host';

/** Error text is stored truncated — enough to triage, never a payload dump. */
export const TELEMETRY_ERROR_CAP = 300;

export interface RequestTelemetryInput {
  provider: string;
  surface: string;
  trafficClass: TrafficClass;
  ok: boolean;
  latencyMs: number;
  statusCode?: number | null;
  sessionId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  /** Pass-through cost when the caller already knows it (e.g. SDK estimates). */
  costMicrousd?: number | null;
  error?: string | null;
  traceId?: string | null;
  details?: Record<string, unknown> | null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Price a token usage against the `llm_pricing_usd_per_mtok` map (per-model
 * `{input, output, cache_read, cache_write}` $/MTok). Returns microUSD, or null
 * when the model is unknown to the map (unknown ≠ free — readers treat null as
 * "unpriced"). The result is an ESTIMATE from list prices, not billing.
 */
export function priceTokensMicrousd(
  db: Database.Database,
  model: string | null | undefined,
  tokens: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  },
): number | null {
  if (!model) return null;
  const counts = [tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheCreationTokens];
  if (!counts.some((c) => typeof c === 'number' && Number.isFinite(c))) return null; // unknown usage ≠ free
  const pricing = getConfig<Record<string, Record<string, number>>>(db, 'llm_pricing_usd_per_mtok');
  const rates = pricing && typeof pricing === 'object' ? pricing[model] : undefined;
  if (!rates || typeof rates !== 'object') return null;
  const per = (count: number | null | undefined, rate: unknown): number =>
    typeof count === 'number' && Number.isFinite(count) && typeof rate === 'number' ? count * rate : 0;
  const usd =
    (per(tokens.inputTokens, rates.input) +
      per(tokens.outputTokens, rates.output) +
      per(tokens.cacheReadTokens, rates.cache_read) +
      per(tokens.cacheCreationTokens, rates.cache_write)) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

/**
 * Insert one telemetry row. Best-effort: any failure (missing table on an
 * un-migrated DB, closed handle, bad input) logs and returns — never throws.
 */
export function recordRequestTelemetry(input: RequestTelemetryInput): void {
  try {
    const db = getDb();
    if (!getConfig<boolean>(db, 'telemetry_capture', true)) return;
    if (!hasTable(db, 'request_telemetry')) return;

    db.prepare(
      `INSERT INTO request_telemetry
         (id, ts, provider, surface, traffic_class, session_id, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_microusd, latency_ms, status_code, ok, error, trace_id, details_json)
       VALUES (@id, @ts, @provider, @surface, @traffic_class, @session_id, @model,
               @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
               @cost_microusd, @latency_ms, @status_code, @ok, @error, @trace_id, @details_json)`,
    ).run({
      id: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      provider: input.provider,
      surface: input.surface,
      traffic_class: input.trafficClass,
      session_id: input.sessionId ?? null,
      model: input.model ?? null,
      input_tokens: numOrNull(input.inputTokens),
      output_tokens: numOrNull(input.outputTokens),
      cache_read_tokens: numOrNull(input.cacheReadTokens),
      cache_creation_tokens: numOrNull(input.cacheCreationTokens),
      cost_microusd: numOrNull(input.costMicrousd),
      latency_ms: numOrNull(input.latencyMs) ?? 0,
      status_code: numOrNull(input.statusCode),
      ok: input.ok ? 1 : 0,
      error: input.error ? String(input.error).slice(0, TELEMETRY_ERROR_CAP) : null,
      trace_id: input.traceId ?? null,
      details_json: input.details ? JSON.stringify(input.details) : null,
    });
  } catch (err) {
    log.warn('request telemetry: record failed', { provider: input.provider, surface: input.surface, err });
  }
}

/**
 * Delete rows strictly older than the retention window. Returns the count.
 * Called from the host-sweep maintenance step.
 */
export function pruneRequestTelemetry(db: Database.Database, retentionDays: number): number {
  if (!hasTable(db, 'request_telemetry')) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare('DELETE FROM request_telemetry WHERE ts < ?').run(cutoff);
  return result.changes;
}
