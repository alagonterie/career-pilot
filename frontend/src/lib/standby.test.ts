import { describe, expect, it } from 'vitest'

import {
  ACTIVE_STATE,
  isStandbyExempt,
  parseStandbySnapshot,
  parseStandbyState,
  parseStandbyVm,
  standbyDuration,
} from './standby'

/**
 * §24.189. The load-bearing property throughout is FAIL OPEN: anything short of an
 * affirmative `standby` record must resolve to the live site, so a KV hiccup can
 * never black out a working public site.
 */
describe('parseStandbyState (§24.189)', () => {
  it('reads an affirmative standby record', () => {
    const raw = JSON.stringify({
      mode: 'standby',
      since: '2026-08-01T00:00:00.000Z',
      note: 'Back in the autumn.',
      vm: 'stopped',
      updatedAt: '2026-08-01T00:00:05.000Z',
    })
    expect(parseStandbyState(raw)).toEqual({
      mode: 'standby',
      since: '2026-08-01T00:00:00.000Z',
      note: 'Back in the autumn.',
      vm: 'stopped',
      updatedAt: '2026-08-01T00:00:05.000Z',
    })
  })

  it('fails OPEN on every unreadable input (a KV hiccup must not black out the site)', () => {
    expect(parseStandbyState(null)).toEqual(ACTIVE_STATE)
    expect(parseStandbyState(undefined)).toEqual(ACTIVE_STATE)
    expect(parseStandbyState('')).toEqual(ACTIVE_STATE)
    expect(parseStandbyState('not json')).toEqual(ACTIVE_STATE)
    expect(parseStandbyState('[]')).toEqual(ACTIVE_STATE)
    expect(parseStandbyState('null')).toEqual(ACTIVE_STATE)
    expect(parseStandbyState('"standby"')).toEqual(ACTIVE_STATE)
  })

  it('treats any mode other than the exact string "standby" as live', () => {
    expect(parseStandbyState(JSON.stringify({ mode: 'active' })).mode).toBe('active')
    expect(parseStandbyState(JSON.stringify({ mode: 'STANDBY' })).mode).toBe('active')
    expect(parseStandbyState(JSON.stringify({ mode: true })).mode).toBe('active')
  })

  it('normalizes a junk vm value + blank strings rather than surfacing them', () => {
    const parsed = parseStandbyState(JSON.stringify({ mode: 'standby', vm: 'exploded', note: '   ' }))
    expect(parsed.vm).toBe('unknown')
    expect(parsed.note).toBeNull()
  })
})

describe('parseStandbyVm (§24.189 — the workflow-owned key)', () => {
  it('accepts the known states as a bare string (what a one-line wrangler put writes)', () => {
    expect(parseStandbyVm('stopped')).toBe('stopped')
    expect(parseStandbyVm('running')).toBe('running')
    expect(parseStandbyVm(' starting\n')).toBe('starting')
  })

  it('returns null for anything unrecognized, so a junk value simply does not overlay', () => {
    expect(parseStandbyVm(null)).toBeNull()
    expect(parseStandbyVm('')).toBeNull()
    expect(parseStandbyVm('exploded')).toBeNull()
    expect(parseStandbyVm('{"vm":"stopped"}')).toBeNull()
  })
})

describe('parseStandbySnapshot (§24.189)', () => {
  it('reads the captured identity', () => {
    const raw = JSON.stringify({
      name: 'A Candidate',
      email: 'a@example.com',
      github: 'https://github.com/x',
      capturedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(parseStandbySnapshot(raw)).toMatchObject({
      name: 'A Candidate',
      email: 'a@example.com',
      github: 'https://github.com/x',
      linkedin: null,
    })
  })

  it('returns null when there is no usable snapshot', () => {
    expect(parseStandbySnapshot(null)).toBeNull()
    expect(parseStandbySnapshot('nope')).toBeNull()
    expect(parseStandbySnapshot('[]')).toBeNull()
  })
})

describe('isStandbyExempt (§24.189 D6)', () => {
  it('exempts the edge console — it has to work precisely when the origin does not', () => {
    expect(isStandbyExempt('/admin/standby')).toBe(true)
    expect(isStandbyExempt('/admin/standby/')).toBe(true)
  })

  it('exempts the static legal pages', () => {
    expect(isStandbyExempt('/privacy')).toBe(true)
    expect(isStandbyExempt('/terms')).toBe(true)
  })

  it('does NOT exempt the backend-fed surfaces (they would render placeholders/offline)', () => {
    for (const p of ['/', '/work', '/experience', '/contact', '/pipeline', '/live', '/simulator', '/admin']) {
      expect(isStandbyExempt(p)).toBe(false)
    }
  })
})

describe('standbyDuration (§24.189)', () => {
  const NOW = Date.parse('2026-08-07T00:00:00.000Z')

  it('reads as whole days, singular at one', () => {
    expect(standbyDuration('2026-08-06T00:00:00.000Z', NOW)).toBe('1 day')
    expect(standbyDuration('2026-07-08T00:00:00.000Z', NOW)).toBe('30 days')
  })

  it('is absent under a day, or with no/unparseable timestamp', () => {
    expect(standbyDuration('2026-08-06T18:00:00.000Z', NOW)).toBeNull()
    expect(standbyDuration(null, NOW)).toBeNull()
    expect(standbyDuration('whenever', NOW)).toBeNull()
  })
})
