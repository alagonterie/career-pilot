/**
 * Container-side request-telemetry reporter.
 *
 * Container code that fetches external APIs directly (rank-leads Haiku,
 * SerpApi search, funnel-curator Gmail/Calendar) cannot write the host's
 * central DB — the one-writer invariant. Instead each call site fires a
 * `career_pilot.record_request_telemetry` system action (fire-and-forget,
 * same transport as per-turn telemetry); the host handler derives the
 * traffic class + session from the session in hand and inserts the row.
 *
 * Contract: `reportRequestTelemetry` NEVER throws into the tool path — a
 * telemetry failure must not break the request it observes. Payload carries
 * NO traffic_class / session_id / cost: the host derives those (trust
 * boundary — a container payload can't claim another class or price itself).
 */
import { sendActionNoWait } from './action.js';

export interface ContainerTelemetry {
  provider: string;
  surface: string;
  ok: boolean;
  latencyMs: number;
  statusCode?: number | null;
  model?: string | null;
  error?: string | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  } | null;
  details?: Record<string, unknown> | null;
}

export async function reportRequestTelemetry(t: ContainerTelemetry): Promise<void> {
  try {
    await sendActionNoWait('career_pilot.record_request_telemetry', {
      provider: t.provider,
      surface: t.surface,
      ok: t.ok,
      latency_ms: t.latencyMs,
      status_code: t.statusCode ?? null,
      model: t.model ?? null,
      error: t.error ?? null,
      input_tokens: t.usage?.inputTokens ?? null,
      output_tokens: t.usage?.outputTokens ?? null,
      cache_read_tokens: t.usage?.cacheReadTokens ?? null,
      cache_creation_tokens: t.usage?.cacheCreationTokens ?? null,
      details: t.details ?? null,
    });
  } catch (err) {
    console.error(`[career-pilot] reportRequestTelemetry failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
