import { describe, expect, it } from 'vitest'

import { activeApplicationCount, heroStats, relativeAgo } from './hero-stats'
import type { AuditEvent } from './use-activity-stream'
import type { FunnelApplication } from './use-funnel'

function app(stage: string): FunnelApplication {
  return {
    application_id: `id-${stage}-${Math.random()}`,
    application_ref: 'Series-B fintech',
    public_state: 'obfuscated',
    role_title: null,
    status: 'active',
    stage,
    applied_at: null,
    stage_entered_at: null,
    last_activity_at: null,
    win_confidence: null,
    win_confidence_rationale: null,
    published_learning: null,
    days_in_stage: null,
    days_in_pipeline: null,
  }
}

function event(ts: string): AuditEvent {
  return {
    seq: 1,
    ts,
    category: 'research',
    agent_name: 'research-company',
    proactive: 0,
    application_ref: null,
    model_used: null,
    tokens: null,
    cost_cents: null,
    cache_hit: null,
    cache_read_pct: null,
    latency_ms: null,
    summary: 'researched',
  }
}

describe('activeApplicationCount', () => {
  it('counts in-flight apps and excludes closed (rejected/withdrawn)', () => {
    const apps = [app('applied'), app('tech'), app('offer'), app('rejected'), app('withdrawn')]
    expect(activeApplicationCount(apps)).toBe(3) // applied, tech, offer
  })

  it('is 0 for an empty pipeline', () => {
    expect(activeApplicationCount([])).toBe(0)
  })
})

describe('relativeAgo', () => {
  const now = Date.UTC(2026, 5, 14, 12, 0, 0)
  it('floors sub-minute and future timestamps to "just now"', () => {
    expect(relativeAgo(new Date(now - 30_000).toISOString(), now)).toBe('just now')
    expect(relativeAgo(new Date(now + 60_000).toISOString(), now)).toBe('just now')
  })
  it('renders minutes, hours, and days', () => {
    expect(relativeAgo(new Date(now - 4 * 60_000).toISOString(), now)).toBe('4m ago')
    expect(relativeAgo(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago')
    expect(relativeAgo(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago')
  })
})

describe('heroStats', () => {
  const now = Date.UTC(2026, 5, 14, 12, 0, 0)

  it('builds all three segments when data is present', () => {
    const segs = heroStats({
      apps: [app('applied'), app('tech')],
      events: [event(new Date(now - 4 * 60_000).toISOString())],
      actionsIn24h: 47,
      now,
    })
    expect(segs).toEqual(['2 active applications', '47 agent actions in 24h', 'last activity 4m ago'])
  })

  it('omits each segment whose number is empty/null/zero (never faked)', () => {
    expect(heroStats({ apps: [], events: [], actionsIn24h: null, now })).toEqual([])
    expect(heroStats({ apps: [app('rejected')], events: [], actionsIn24h: 0, now })).toEqual([])
  })

  it('singularizes counts of one', () => {
    const segs = heroStats({ apps: [app('applied')], events: [], actionsIn24h: 1, now })
    expect(segs).toEqual(['1 active application', '1 agent action in 24h'])
  })

  it('uses the newest event (last in the ascending buffer) for last-activity', () => {
    const segs = heroStats({
      apps: [],
      events: [event(new Date(now - 3 * 3_600_000).toISOString()), event(new Date(now - 5 * 60_000).toISOString())],
      actionsIn24h: null,
      now,
    })
    expect(segs).toEqual(['last activity 5m ago'])
  })
})
