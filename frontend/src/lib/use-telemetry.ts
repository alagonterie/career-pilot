import { useSurfaceState, withState } from './dev-state'
import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * Local per-turn telemetry aggregates (§24.34) — the source for the /live "LLM
 * telemetry" + "Cost & cache" panels. Sourced entirely from our own
 * public_audit_trail turn rows, NOT Portkey's analytics API (that needs an
 * Enterprise admin key — see STRATEGY §24.47). cost is the SDK estimate, labeled
 * "est" in the UI; "turns" (not raw gateway requests) and "turn p50/p95" (whole
 * turn, not per-request) keep the viewer-facing numbers honest.
 */
export interface TelemetryLocal {
  simulator_runs_total: number
  activity_events_total: number
  activity_events_24h: number
  turns_total: number
  turns_24h: number
  turn_cost_cents_total: number
  turn_cost_cents_24h: number
  /** Simulator spend (§24.55) — per-run SDK estimates summed; joins the combined headline. */
  sim_cost_cents_total: number
  sim_cost_cents_24h: number
  cache_hit_rate: number | null // 0..1
  turn_p50_ms: number | null
  turn_p95_ms: number | null
  top_model: string | null
}

/** The `GET /api/telemetry` payload (src/modules/portal/portkey-analytics.ts). */
export interface Telemetry {
  local: TelemetryLocal
}

export interface TelemetryState {
  data: Telemetry | null
  status: PollStatus
}

/** Poll `GET /api/telemetry` (the generic `usePolledJson` primitive again). */
export function useTelemetry(baseUrl: string, pollMs?: number): TelemetryState {
  const forced = useSurfaceState('telemetry')
  return usePolledJson<Telemetry>(withState(`${baseUrl}/api/telemetry`, forced), pollMs)
}

/** The view-model the telemetry/cost panels render from. */
export interface TelemetryView {
  local: TelemetryLocal | null
  /** True once at least one agent turn has been captured (gates the metric lanes). */
  hasTurns: boolean
}

/**
 * Pure mapping of the raw `/api/telemetry` payload to the panel view-model. The
 * lanes render from real local turn data; `hasTurns` drives the "awaiting first
 * agent turn" empty state. Testable without a network.
 */
export function deriveTelemetryView(t: Telemetry | null): TelemetryView {
  const local = t?.local ?? null
  return { local, hasTurns: (local?.turns_total ?? 0) > 0 }
}
