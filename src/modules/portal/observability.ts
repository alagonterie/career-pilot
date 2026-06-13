/**
 * src/modules/portal/observability.ts — /api/observability assembler (§24.69).
 *
 * Surfaces the §24.68 `request_telemetry` table on the portal: per-traffic-class
 * 24 h spend (with hourly sparkline buckets), per-provider 24 h health, and live
 * session topology. ONE endpoint feeds two consumers — the /live SPEND BY CLASS
 * panel and the /architecture node-health badges + Orchestrator-modal topology.
 *
 * §9 boundary (the load-bearing rule): `request_telemetry` is a PRIVATE table,
 * but every read here is an **aggregate-only** projection — SUM / COUNT / a
 * percentile over a latency stream — that NEVER selects `error`, `session_id`,
 * `trace_id`, or `details_json`. The served payload therefore carries no PII and
 * no per-request rows; a regression test (`observability.test.ts`) pins that the
 * response shape contains none of those keys. This is the deliberate, narrowly
 * scoped relaxation of §9's "public tables only" wording recorded in §24.69 D-C.
 *
 * Cached 30 s (`portal_observability_cache_ms`), mirroring portkey-analytics.ts.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getActiveSessions } from '../../db/sessions.js';
import { getConfig } from '../../get-config.js';
import type { Session } from '../../types.js';
import { OWNER_GROUP_FOLDER, isOpsSession } from '../career-pilot/ops-session.js';

const DEFAULT_OBSERVABILITY_CACHE_MS = 30_000;
const DEFAULT_ERROR_RATE_DEGRADED = 0.25;
const DEFAULT_STALE_SUCCESS_SEC = 3600;
const WINDOW_MS = 86_400_000; // 24 h
const BUCKETS = 24; // one per hour of the window
const SECONDS_PER_BUCKET = 3600;

export type TrafficClass = 'ops' | 'chat' | 'sandbox' | 'host';

/** A class's last-24h spend plus 24 hourly buckets (oldest → newest) for a sparkline. */
export interface SpendBucket {
  microusd_24h: number;
  buckets: number[];
}

/** Derived health for a single provider. `idle` is a frontend-only state (a node
 * whose mapped providers have NO rows in the window) — a listed provider always
 * has ≥1 request, so the backend only ever emits healthy/degraded/down. */
export type ProviderStatus = 'healthy' | 'degraded' | 'down';

/** Per-provider 24h health — drives the architecture node badges + modal facts. */
export interface ProviderStat {
  provider: string;
  requests_24h: number;
  errors_24h: number;
  /** 0..1 — errors / requests. */
  error_rate: number;
  /** Seconds since the most recent ok=1 row; null if never succeeded in window. */
  last_success_age_sec: number | null;
  /** Nearest-rank p50 of latency_ms over the window; null if no timed rows. */
  p50_ms: number | null;
  /** Status derived HERE from the §24.69 D7 config thresholds — keeps the
   * thresholds in the four-tier config and the frontend purely presentational. */
  status: ProviderStatus;
}

/** Active-session counts by traffic class (the §24.67 split) — non-PII counts. */
export interface SessionTopology {
  chat: number;
  ops: number;
  sandbox: number;
}

export interface Observability {
  spend_by_class: Record<TrafficClass, SpendBucket>;
  providers: ProviderStat[];
  session_topology: SessionTopology;
}

const CLASSES: TrafficClass[] = ['ops', 'chat', 'sandbox', 'host'];

let cache: { at: number; value: Observability } | null = null;

/** Nearest-rank percentile over an ascending-sorted array; null when empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

/**
 * Map a provider's window stats → status using the §24.69 D7 thresholds:
 * every attempt failed ⇒ `down`; elevated error rate OR a stale/absent last
 * success ⇒ `degraded`; else `healthy`. (Listed providers always have ≥1 row.)
 */
function providerStatus(
  s: { requests_24h: number; errors_24h: number; error_rate: number; last_success_age_sec: number | null },
  errRateDegraded: number,
  staleSuccessSec: number,
): ProviderStatus {
  if (s.errors_24h >= s.requests_24h) return 'down';
  if (s.error_rate >= errRateDegraded) return 'degraded';
  if (s.last_success_age_sec == null || s.last_success_age_sec > staleSuccessSec) return 'degraded';
  return 'healthy';
}

function emptySpend(): Record<TrafficClass, SpendBucket> {
  const out = {} as Record<TrafficClass, SpendBucket>;
  for (const c of CLASSES) out[c] = { microusd_24h: 0, buckets: new Array<number>(BUCKETS).fill(0) };
  return out;
}

export function emptyObservability(): Observability {
  return { spend_by_class: emptySpend(), providers: [], session_topology: { chat: 0, ops: 0, sandbox: 0 } };
}

/** Replicates actions.ts `deriveTrafficClass` — kept local (that one is private). */
function classifySession(session: Session): TrafficClass {
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== OWNER_GROUP_FOLDER) return 'sandbox';
  return isOpsSession(session) ? 'ops' : 'chat';
}

function computeSessionTopology(): SessionTopology {
  const topo: SessionTopology = { chat: 0, ops: 0, sandbox: 0 };
  let sessions: Session[] = [];
  try {
    sessions = getActiveSessions();
  } catch {
    // Bare/pre-migration DB — no sessions to classify.
    return topo;
  }
  for (const s of sessions) {
    const cls = classifySession(s);
    if (cls === 'ops') topo.ops++;
    else if (cls === 'sandbox') topo.sandbox++;
    else topo.chat++;
  }
  return topo;
}

/**
 * Compute the observability view uncached. `now` is injectable for deterministic
 * bucket/age tests. Every telemetry read is aggregate-only (D2).
 */
export function computeObservability(now: number = Date.now()): Observability {
  const db = getDb();
  const session_topology = computeSessionTopology();
  if (!hasTable(db, 'request_telemetry')) {
    // Telemetry table absent (pre-migration) — spend/providers degrade to empty,
    // but topology (a different table) is still meaningful.
    return { ...emptyObservability(), session_topology };
  }

  const cutoffMs = now - WINDOW_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const nowEpoch = Math.floor(now / 1000);
  const errRateDegraded = getConfig<number>(db, 'arch_provider_error_rate_degraded', DEFAULT_ERROR_RATE_DEGRADED);
  const staleSuccessSec = getConfig<number>(db, 'arch_provider_stale_success_sec', DEFAULT_STALE_SUCCESS_SEC);

  // ── spend_by_class: SUM(cost) GROUP BY (class, hourly bucket) ──────────────
  // Bucket counts back from NOW: a row at `now` lands in the newest lane
  // (BUCKETS-1), one ~23.5h old in lane 0; older than the window → negative
  // (dropped by the guard below).
  const spend_by_class = emptySpend();
  const spendRows = db
    .prepare(
      `SELECT traffic_class AS cls,
              (@last - CAST((@now - CAST(strftime('%s', ts) AS INTEGER)) / @per AS INTEGER)) AS bucket,
              SUM(COALESCE(cost_microusd, 0)) AS microusd
         FROM request_telemetry
        WHERE ts >= @cutoff
        GROUP BY cls, bucket`,
    )
    .all({ last: BUCKETS - 1, now: nowEpoch, per: SECONDS_PER_BUCKET, cutoff: cutoffIso }) as Array<{
    cls: string;
    bucket: number;
    microusd: number;
  }>;
  for (const r of spendRows) {
    const lane = spend_by_class[r.cls as TrafficClass];
    if (!lane) continue; // CHECK guards the column, but be defensive
    if (r.bucket < 0 || r.bucket >= BUCKETS) continue; // clock-skew guard
    const v = r.microusd ?? 0;
    lane.buckets[r.bucket] += v;
    lane.microusd_24h += v;
  }

  // ── providers: per-provider counts + last success ─────────────────────────
  const provRows = db
    .prepare(
      `SELECT provider AS provider,
              COUNT(*) AS requests,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
              MAX(CASE WHEN ok = 1 THEN ts ELSE NULL END) AS last_success_ts
         FROM request_telemetry
        WHERE ts >= @cutoff
        GROUP BY provider
        ORDER BY provider ASC`,
    )
    .all({ cutoff: cutoffIso }) as Array<{
    provider: string;
    requests: number;
    errors: number;
    last_success_ts: string | null;
  }>;

  // p50 latency per provider — pulled as a sorted latency stream, reduced to a
  // single percentile before serving (per-row latencies never leave this fn).
  const latRows = db
    .prepare(
      `SELECT provider, latency_ms
         FROM request_telemetry
        WHERE ts >= @cutoff AND latency_ms IS NOT NULL
        ORDER BY provider ASC, latency_ms ASC`,
    )
    .all({ cutoff: cutoffIso }) as Array<{ provider: string; latency_ms: number }>;
  const latByProvider = new Map<string, number[]>();
  for (const r of latRows) {
    const arr = latByProvider.get(r.provider) ?? [];
    arr.push(r.latency_ms);
    latByProvider.set(r.provider, arr);
  }

  const providers: ProviderStat[] = provRows.map((r) => {
    const base = {
      provider: r.provider,
      requests_24h: r.requests,
      errors_24h: r.errors,
      error_rate: r.requests > 0 ? r.errors / r.requests : 0,
      last_success_age_sec: r.last_success_ts
        ? Math.max(0, Math.floor((now - Date.parse(r.last_success_ts)) / 1000))
        : null,
      p50_ms: percentile(latByProvider.get(r.provider) ?? [], 50),
    };
    return { ...base, status: providerStatus(base, errRateDegraded, staleSuccessSec) };
  });

  return { spend_by_class, providers, session_topology };
}

export async function getObservability(): Promise<Observability> {
  let cacheMs = DEFAULT_OBSERVABILITY_CACHE_MS;
  try {
    cacheMs = getConfig<number>(getDb(), 'portal_observability_cache_ms', DEFAULT_OBSERVABILITY_CACHE_MS);
  } catch {
    cacheMs = DEFAULT_OBSERVABILITY_CACHE_MS;
  }
  if (cache && Date.now() - cache.at < cacheMs) return cache.value;

  const value = computeObservability();
  cache = { at: Date.now(), value };
  return value;
}

/** Test seam — drop the 30s cache. */
export function _resetObservabilityCache(): void {
  cache = null;
}
