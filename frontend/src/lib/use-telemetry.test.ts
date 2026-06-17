import { describe, expect, it } from 'vitest'

import { deriveTelemetryView, type Telemetry } from './use-telemetry'

const LOCAL = {
  simulator_runs_total: 3,
  activity_events_total: 42,
  activity_events_24h: 12,
  last_activity_at: '2026-06-16T10:00:00.000Z',
  turns_total: 8,
  turns_24h: 5,
  turn_cost_cents_total: 37,
  turn_cost_cents_24h: 12,
  sim_cost_cents_total: 72,
  sim_cost_cents_24h: 24,
  cache_hit_rate: 0.66,
  turn_p50_ms: 15000,
  turn_p95_ms: 31000,
  top_model: 'claude-haiku-4-5',
}

describe('deriveTelemetryView (telemetry view-model)', () => {
  it('is empty (no local, no turns) before the first payload', () => {
    expect(deriveTelemetryView(null)).toEqual({ local: null, hasTurns: false })
  })

  it('surfaces the local aggregates + hasTurns once turns have been captured', () => {
    const v = deriveTelemetryView({ local: LOCAL } satisfies Telemetry)
    expect(v.local).toEqual(LOCAL)
    expect(v.hasTurns).toBe(true)
  })

  it('reports hasTurns=false when no turns are captured yet, but keeps the real local aggregates', () => {
    const v = deriveTelemetryView({ local: { ...LOCAL, turns_total: 0 } } satisfies Telemetry)
    expect(v.hasTurns).toBe(false)
    expect(v.local?.activity_events_total).toBe(42)
  })
})
