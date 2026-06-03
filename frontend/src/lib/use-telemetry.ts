import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * The Portkey analytics summary shape the /live panels consume. Every field is
 * optional: the real Portkey response schema is uncalibrated (the backend ships
 * a raw passthrough until a later calibration pass — §24.17), so we render only
 * the fields actually present rather than asserting a contract we haven't pinned.
 */
export interface PortkeySummary {
  total_requests?: number
  cache_hit_rate?: number // 0..1
  p50_latency_ms?: number
  p95_latency_ms?: number
  total_cost_usd?: number
  top_model?: string
}

/** Always-real local aggregates computed from the public tables (no Portkey). */
export interface TelemetryLocal {
  simulator_runs_total: number
  activity_events_total: number
  activity_events_24h: number
  // Real local spend, summed over the per-turn telemetry rows (§24.34) — the
  // honest counterpart to the Portkey aggregate, present even when Portkey is
  // unavailable. cost_cents is an SDK estimate, labeled as such in the panel.
  turns_total: number
  turn_cost_cents_total: number
  turn_cost_cents_24h: number
}

/** The `GET /api/telemetry` payload (src/modules/portal/portkey-analytics.ts). */
export interface Telemetry {
  portkey: { available: boolean; reason?: string; summary?: PortkeySummary }
  local: TelemetryLocal
}

export interface TelemetryState {
  data: Telemetry | null
  status: PollStatus
}

/** Poll `GET /api/telemetry` (the generic `usePolledJson` primitive again). */
export function useTelemetry(baseUrl: string, pollMs?: number): TelemetryState {
  return usePolledJson<Telemetry>(`${baseUrl}/api/telemetry`, pollMs)
}

/** The view-model the telemetry/cost panels render from. */
export interface TelemetryView {
  available: boolean
  reason: string | null
  summary: PortkeySummary | null
  local: TelemetryLocal | null
}

const REASON_LABEL: Record<string, string> = {
  bypass: 'Portkey bypass enabled',
  no_key: 'no Portkey key configured',
  unreachable: 'Portkey unreachable',
  mock_parse_error: 'mock parse error',
}

/**
 * Pure mapping of the raw `/api/telemetry` payload to the panel view-model: the
 * Portkey lanes are `available` only when the backend says so AND a summary is
 * present; otherwise a human-readable `reason` drives the honest "not connected"
 * state (the §24.24 / §10 render-if-present discipline). `local` aggregates are
 * always real and pass through untouched. Testable without a network.
 */
export function deriveTelemetryView(t: Telemetry | null): TelemetryView {
  if (!t) return { available: false, reason: null, summary: null, local: null }
  const p = t.portkey
  const available = p.available === true && p.summary != null
  const reason = available ? null : (REASON_LABEL[p.reason ?? ''] ?? p.reason ?? 'telemetry pending')
  return { available, reason, summary: available ? (p.summary ?? null) : null, local: t.local }
}
