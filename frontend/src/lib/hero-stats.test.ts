import { describe, expect, it } from 'vitest'

import { activeApplicationCount, heroStatPhase, heroStats, relativeAgo, searchingSince } from './hero-stats'
import type { AuditEvent } from './use-activity-stream'
import type { PipelineApplication } from './use-pipeline'

function app(stage: string, opts: Partial<PipelineApplication> = {}): PipelineApplication {
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
    ...opts,
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
  it('counts the five board stages, excluding closed (rejected/withdrawn) and pre-application bookmarked (§24.97-A)', () => {
    const apps = [
      app('applied'),
      app('tech'),
      app('offer'),
      app('rejected'),
      app('withdrawn'),
      app('bookmarked'), // a lead the agent found but hasn't applied to — not an "application"
    ]
    // applied, tech, offer — the bookmarked lead is invisible in the strip below,
    // so counting it here would read as "3 active" over a strip summing to 2.
    expect(activeApplicationCount(apps)).toBe(3)
  })

  it('excludes a bookmarked lead so the headline equals the strip column sum', () => {
    expect(activeApplicationCount([app('applied'), app('applied'), app('bookmarked')])).toBe(2)
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
    expect(segs).toEqual(['2 active job applications', '47 agent actions in 24h', 'last activity 4m ago'])
  })

  it('omits each segment whose number is empty/null/zero (never faked)', () => {
    expect(heroStats({ apps: [], events: [], actionsIn24h: null, now })).toEqual([])
    expect(heroStats({ apps: [app('rejected')], events: [], actionsIn24h: 0, now })).toEqual([])
  })

  it('singularizes counts of one', () => {
    const segs = heroStats({ apps: [app('applied')], events: [], actionsIn24h: 1, now })
    expect(segs).toEqual(['1 active job application', '1 agent action in 24h'])
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

  it('adds the "searching since" anchor (after the count) when applications carry an applied_at (§24.149)', () => {
    const segs = heroStats({
      apps: [
        app('applied', { applied_at: '2026-03-15T12:00:00Z' }),
        app('tech', { applied_at: '2026-01-04T12:00:00Z' }),
      ],
      events: [event(new Date(now - 4 * 60_000).toISOString())],
      actionsIn24h: 47,
      now,
    })
    expect(segs).toEqual([
      '2 active job applications',
      'searching since Jan 2026',
      '47 agent actions in 24h',
      'last activity 4m ago',
    ])
  })
})

describe('searchingSince (§24.149)', () => {
  it('returns the EARLIEST application month, formatted "Mon YYYY" in UTC', () => {
    expect(
      searchingSince([
        app('applied', { applied_at: '2026-03-15T12:00:00Z' }),
        app('offer', { applied_at: '2026-01-04T12:00:00Z' }),
        app('rejected', { applied_at: '2026-05-20T12:00:00Z' }),
      ]),
    ).toBe('Jan 2026')
  })

  it('is null at cold-start — no application carries an applied_at', () => {
    expect(searchingSince([])).toBeNull()
    expect(searchingSince([app('applied'), app('bookmarked')])).toBeNull() // factory applied_at: null
  })

  it('ignores an unparseable applied_at', () => {
    expect(searchingSince([app('applied', { applied_at: 'not-a-date' })])).toBeNull()
  })
})

describe('heroStatPhase (§24.149 L1 — never a perpetual skeleton on a cold launch)', () => {
  it('shows the live stats whenever there is anything to show', () => {
    expect(heroStatPhase({ hasStats: true, ready: false, offline: false })).toBe('stats')
    expect(heroStatPhase({ hasStats: true, ready: true, offline: true })).toBe('stats')
  })

  it('skeletons only while the first polls are genuinely in flight', () => {
    expect(heroStatPhase({ hasStats: false, ready: false, offline: false })).toBe('loading')
  })

  it('settles into the fresh "warming up" line when the polls land empty (cold launch)', () => {
    expect(heroStatPhase({ hasStats: false, ready: true, offline: false })).toBe('fresh')
  })

  it('collapses (not skeleton, not fresh) when both sources are offline', () => {
    expect(heroStatPhase({ hasStats: false, ready: true, offline: true })).toBe('offline')
  })
})
