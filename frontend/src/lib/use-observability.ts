import { useSurfaceState, withState } from './dev-state'
import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * The `GET /api/observability` payload (src/modules/portal/observability.ts) —
 * per-traffic-class 24h spend (with hourly sparkline buckets), per-provider 24h
 * health, and live session topology, all aggregated from the private
 * request_telemetry table. Aggregate-only by construction: no per-request rows,
 * no error/session/trace fields (the §9 boundary; §24.69). Consumed by the
 * /live SPEND BY CLASS panel and the /architecture node badges + topology.
 */
export type TrafficClass = 'ops' | 'chat' | 'sandbox' | 'host'

export interface SpendBucket {
  microusd_24h: number
  /** 24 hourly cost sums (oldest → newest) for the sparkline. */
  buckets: number[]
}

export type ProviderStatus = 'healthy' | 'degraded' | 'down'

export interface ProviderStat {
  provider: string
  requests_24h: number
  errors_24h: number
  error_rate: number
  last_success_age_sec: number | null
  p50_ms: number | null
  status: ProviderStatus
}

export interface SessionTopology {
  chat: number
  ops: number
  sandbox: number
}

export interface Observability {
  spend_by_class: Record<TrafficClass, SpendBucket>
  providers: ProviderStat[]
  session_topology: SessionTopology
}

export interface ObservabilityState {
  data: Observability | null
  status: PollStatus
}

/** Poll `GET /api/observability` (the shared `usePolledJson` primitive). */
export function useObservability(baseUrl: string, pollMs?: number): ObservabilityState {
  const forced = useSurfaceState('observability')
  return usePolledJson<Observability>(withState(`${baseUrl}/api/observability`, forced), pollMs)
}

/** Look up one provider's stats by name (null when absent from the window). */
export function findProvider(obs: Observability | null, provider: string): ProviderStat | null {
  return obs?.providers.find((p) => p.provider === provider) ?? null
}
