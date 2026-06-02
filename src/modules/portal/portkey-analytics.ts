/**
 * src/modules/portal/portkey-analytics.ts — /api/telemetry assembler.
 *
 * Sub-milestone 5.3 (STRATEGY.md §24.17). Combines Portkey's analytics summary
 * with locally-computable aggregates, cached 30s (PORTAL §11) so the public
 * dashboard never hammers Portkey.
 *
 * Portkey source: GET https://api.portkey.ai/v1/analytics/summary?range=1d
 * with header `x-portkey-api-key: $PORTKEY_API_KEY`. Degrades gracefully per
 * PORTAL §10 — when PORTKEY_BYPASS=true, the key is unset, or the call
 * errors/times out, `portkey.available=false` and the frontend renders `—`.
 *
 * Field-level normalization of the live summary (cache rate, p50/p95, top
 * model) is calibrated against a real response in a later pass — there is no
 * live Portkey in dev, so we ship the raw passthrough + the tested degraded
 * path rather than bluffing Portkey's schema.
 *
 * See STRATEGY.md §12 (Portkey bypass) + §17 + §24.17.
 */
import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

const PORTKEY_ANALYTICS_URL = 'https://api.portkey.ai/v1/analytics/summary?range=1d';
const DEFAULT_TELEMETRY_CACHE_MS = 30_000;
const PORTKEY_FETCH_TIMEOUT_MS = 4000;

export interface PortkeyResult {
  available: boolean;
  reason?: string;
  summary?: unknown;
}

export interface TelemetryLocal {
  simulator_runs_total: number;
  activity_events_total: number;
  activity_events_24h: number;
}

export interface Telemetry {
  portkey: PortkeyResult;
  local: TelemetryLocal;
}

let cache: { at: number; value: Telemetry } | null = null;

export async function getPortkeyAnalytics(): Promise<PortkeyResult> {
  if (process.env.PORTKEY_BYPASS === 'true') return { available: false, reason: 'bypass' };
  const key = process.env.PORTKEY_API_KEY;
  if (!key) return { available: false, reason: 'no_key' };
  try {
    const res = await fetch(PORTKEY_ANALYTICS_URL, {
      headers: { 'x-portkey-api-key': key },
      signal: AbortSignal.timeout(PORTKEY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { available: false, reason: `http_${res.status}` };
    return { available: true, summary: await res.json() };
  } catch (err) {
    log.warn('portkey analytics fetch failed', { err });
    return { available: false, reason: 'unreachable' };
  }
}

function computeLocal(): TelemetryLocal {
  const db = getDb();
  const sim = db.prepare('SELECT COUNT(*) AS n FROM simulator_runs').get() as { n: number };
  const evTotal = db.prepare('SELECT COUNT(*) AS n FROM public_audit_trail').get() as { n: number };
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const ev24 = db.prepare('SELECT COUNT(*) AS n FROM public_audit_trail WHERE ts >= ?').get(cutoff) as { n: number };
  return {
    simulator_runs_total: sim.n,
    activity_events_total: evTotal.n,
    activity_events_24h: ev24.n,
  };
}

export async function getTelemetry(): Promise<Telemetry> {
  let cacheMs = DEFAULT_TELEMETRY_CACHE_MS;
  try {
    cacheMs = getConfig<number>(getDb(), 'portal_telemetry_cache_ms', DEFAULT_TELEMETRY_CACHE_MS);
  } catch {
    cacheMs = DEFAULT_TELEMETRY_CACHE_MS;
  }
  if (cache && Date.now() - cache.at < cacheMs) return cache.value;

  const portkey = await getPortkeyAnalytics();
  const local = computeLocal();
  const value: Telemetry = { portkey, local };
  cache = { at: Date.now(), value };
  return value;
}

/** Test seam — drop the 30s cache. */
export function _resetTelemetryCache(): void {
  cache = null;
}
