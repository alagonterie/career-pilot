/**
 * src/modules/portal/portkey-analytics.ts — /api/telemetry assembler.
 *
 * Powers the /live "LLM telemetry" + "Cost & cache" panels, sourced entirely
 * from LOCAL per-turn telemetry (§24.34) — the `category='turn'` rows in
 * public_audit_trail that carry model / tokens / cost / cache tokens / duration.
 *
 * Why not Portkey's analytics API? It requires an Admin API key, which is
 * Enterprise-plan-only (verified on the dev box 2026-06-06: the workspace
 * gateway key gets 403 `AB03` on /v1/analytics/graphs/*; the old coded
 * /v1/analytics/summary endpoint 404'd — it never existed). Routing through
 * Portkey still works (turns are metered), but the analytics REST API is out of
 * reach on the free tier — so these panels read data we already capture. The
 * cost is the SDK *estimate* (labeled "est" in the UI), not Portkey billing.
 * Cached 30s (PORTAL §11). See STRATEGY.md §24.47 (history: §24.17/§24.46).
 */
import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';

const DEFAULT_TELEMETRY_CACHE_MS = 30_000;

export interface TelemetryLocal {
  simulator_runs_total: number;
  activity_events_total: number;
  /** ALL audit rows in 24h, incl. per-turn cost seals — the dashboard's raw
   *  "events / 24h" telemetry row. NOT the hero's "agent actions" (see below). */
  activity_events_24h: number;
  /** NON-turn audit rows in 24h — the hero "N agent actions in 24h" source. It
   *  must share the population the ticker + `last_activity_at` use (both exclude
   *  `turn` rows), else the hero line contradicts itself (§24.97-B: "8 actions in
   *  24h · last activity 2d ago" when the only 24h rows are turns). */
  agent_actions_24h: number;
  /** ISO ts of the most recent NON-turn activity event — the hero "last activity"
   *  source (matches the home ticker, which excludes `turn` cost-summary rows);
   *  null when there's no activity. Lets `/` SSR a complete, stable stat line. */
  last_activity_at: string | null;
  // Per-turn LLM telemetry (§24.34), aggregated. cost_cents is an SDK estimate
  // (labeled as such in the UI). The derived lanes (cache rate, p50/p95, top
  // model) come from the turn rows' details_json (duration_api_ms + model_usage).
  turns_total: number;
  turns_24h: number;
  turn_cost_cents_total: number;
  turn_cost_cents_24h: number;
  // Simulator spend (§24.55) — the public sandbox's per-run SDK estimates
  // (simulator_runs.total_cost_cents), summed so the Cost & cache panel shows
  // the COMBINED estimate. Without these the panel omitted a whole spend lane.
  sim_cost_cents_total: number;
  sim_cost_cents_24h: number;
  /** 0..1 — Σ cache_read / Σ all prompt tokens over the 24h turns; null if no data. */
  cache_hit_rate: number | null;
  /** p50/p95 of per-turn duration_api_ms over the 24h turns; null if no data. */
  turn_p50_ms: number | null;
  turn_p95_ms: number | null;
  /** Most-frequent model_used over the 24h turns; null if no data. */
  top_model: string | null;
}

export interface Telemetry {
  local: TelemetryLocal;
}

interface TurnModelUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
}

let cache: { at: number; value: Telemetry } | null = null;

/** Nearest-rank percentile over an ascending-sorted array; null when empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

function computeLocal(): TelemetryLocal {
  const db = getDb();
  const sim = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_cents), 0) AS cents FROM simulator_runs')
    .get() as { n: number; cents: number };
  const evTotal = db.prepare('SELECT COUNT(*) AS n FROM public_audit_trail').get() as { n: number };
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const ev24 = db.prepare('SELECT COUNT(*) AS n FROM public_audit_trail WHERE ts >= ?').get(cutoff) as { n: number };
  // Non-turn rows in 24h — the hero "agent actions" count. Excludes `turn` cost
  // seals so it agrees with the ticker + `last_activity_at` (§24.97-B).
  const act24 = db
    .prepare(`SELECT COUNT(*) AS n FROM public_audit_trail WHERE category != 'turn' AND ts >= ?`)
    .get(cutoff) as { n: number };
  // Latest non-turn event ts (the home ticker excludes `turn` rows, so the hero
  // "last activity" must too — else the SSR seed and the live ticker disagree).
  const lastEv = db.prepare(`SELECT MAX(ts) AS ts FROM public_audit_trail WHERE category != 'turn'`).get() as {
    ts: string | null;
  };
  const sim24 = db
    .prepare('SELECT COALESCE(SUM(total_cost_cents), 0) AS cents FROM simulator_runs WHERE ts >= ?')
    .get(cutoff) as { cents: number };

  // All captured turn rows. The windowed counts (turns_24h / spend-today) gate on
  // `ts`; the derived lanes (cache rate, p50/p95, top model) aggregate over ALL
  // turns — labeled without a "24h" qualifier — so the panels stay populated on a
  // quiet day (turn capture is sparse and gated; §24.34). duration + cache tokens
  // live in details_json, not as columns, so we parse it in JS.
  const turnRows = db
    .prepare(`SELECT ts, model_used, cost_cents, details_json FROM public_audit_trail WHERE category = 'turn'`)
    .all() as Array<{
    ts: string;
    model_used: string | null;
    cost_cents: number | null;
    details_json: string | null;
  }>;

  let costTotal = 0;
  let cost24 = 0;
  let turns24 = 0;
  let cacheRead = 0;
  let promptTotal = 0;
  const durations: number[] = [];
  const modelCounts = new Map<string, number>();
  for (const r of turnRows) {
    const cents = r.cost_cents ?? 0;
    costTotal += cents;
    if (r.ts >= cutoff) {
      turns24++;
      cost24 += cents;
    }
    if (r.model_used) modelCounts.set(r.model_used, (modelCounts.get(r.model_used) ?? 0) + 1);
    if (!r.details_json) continue;
    let d: { duration_api_ms?: number; model_usage?: Record<string, TurnModelUsage> };
    try {
      d = JSON.parse(r.details_json) as typeof d;
    } catch {
      continue;
    }
    if (typeof d.duration_api_ms === 'number' && d.duration_api_ms > 0) durations.push(d.duration_api_ms);
    for (const u of Object.values(d.model_usage ?? {})) {
      const read = u.cache_read ?? 0;
      cacheRead += read;
      promptTotal += (u.input ?? 0) + read + (u.cache_creation ?? 0);
    }
  }

  let topModel: string | null = null;
  let topCount = -1;
  for (const [m, n] of modelCounts) {
    if (n > topCount) {
      topModel = m;
      topCount = n;
    }
  }
  durations.sort((a, b) => a - b);

  return {
    simulator_runs_total: sim.n,
    activity_events_total: evTotal.n,
    activity_events_24h: ev24.n,
    agent_actions_24h: act24.n,
    last_activity_at: lastEv.ts ?? null,
    turns_total: turnRows.length,
    turns_24h: turns24,
    turn_cost_cents_total: costTotal,
    turn_cost_cents_24h: cost24,
    sim_cost_cents_total: sim.cents,
    sim_cost_cents_24h: sim24.cents,
    cache_hit_rate: promptTotal > 0 ? cacheRead / promptTotal : null,
    turn_p50_ms: percentile(durations, 50),
    turn_p95_ms: percentile(durations, 95),
    top_model: topModel,
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

  const value: Telemetry = { local: computeLocal() };
  cache = { at: Date.now(), value };
  return value;
}

/** Test seam — drop the 30s cache. */
export function _resetTelemetryCache(): void {
  cache = null;
}
