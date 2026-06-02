import { describe, expect, it } from 'vitest'

import { deriveTelemetryView, type Telemetry } from './use-telemetry'

const LOCAL = { simulator_runs_total: 3, activity_events_total: 42, activity_events_24h: 12 }

describe('deriveTelemetryView (telemetry view-model)', () => {
  it('is unavailable with a null reason before the first payload', () => {
    const v = deriveTelemetryView(null)
    expect(v).toEqual({ available: false, reason: null, summary: null, local: null })
  })

  it('surfaces the Portkey summary + local aggregates when available', () => {
    const t: Telemetry = {
      portkey: { available: true, summary: { total_requests: 1284, cache_hit_rate: 0.62, top_model: 'opus-4-8' } },
      local: LOCAL,
    }
    const v = deriveTelemetryView(t)
    expect(v.available).toBe(true)
    expect(v.reason).toBeNull()
    expect(v.summary?.top_model).toBe('opus-4-8')
    expect(v.local).toEqual(LOCAL)
  })

  it('maps the unavailable reason to a human label but keeps the real local aggregates', () => {
    const t: Telemetry = { portkey: { available: false, reason: 'no_key' }, local: LOCAL }
    const v = deriveTelemetryView(t)
    expect(v.available).toBe(false)
    expect(v.reason).toMatch(/no Portkey key/i)
    expect(v.summary).toBeNull()
    expect(v.local).toEqual(LOCAL) // local is always real, even when Portkey is dark
  })

  it('treats available-but-summary-missing as unavailable (no contract to render)', () => {
    const t: Telemetry = { portkey: { available: true }, local: LOCAL }
    expect(deriveTelemetryView(t).available).toBe(false)
  })

  it('passes an unknown reason code through verbatim', () => {
    const t: Telemetry = { portkey: { available: false, reason: 'http_503' }, local: LOCAL }
    expect(deriveTelemetryView(t).reason).toBe('http_503')
  })
})
