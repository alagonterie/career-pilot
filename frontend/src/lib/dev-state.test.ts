import { afterEach, describe, expect, it } from 'vitest'

import { effectiveState, resetSurfaceStates, setSurfaceState, withState } from './dev-state'

afterEach(() => resetSurfaceStates())

describe('withState (§24.36 36.1)', () => {
  it('is a no-op for the normal state', () => {
    expect(withState('http://x/api/funnel', 'normal')).toBe('http://x/api/funnel')
  })

  it('appends ?__state with a fresh query string', () => {
    expect(withState('http://x/api/funnel', 'loading')).toBe('http://x/api/funnel?__state=loading')
  })

  it('appends &__state when the url already has a query', () => {
    expect(withState('http://x/api/activity/stream?since=0', 'error')).toBe(
      'http://x/api/activity/stream?since=0&__state=error',
    )
  })
})

describe('the per-surface override store', () => {
  it('defaults every surface to normal', () => {
    expect(effectiveState('pipeline')).toBe('normal')
    expect(effectiveState('activity')).toBe('normal')
  })

  it('sets one surface without touching the others', () => {
    setSurfaceState('pipeline', 'empty')
    expect(effectiveState('pipeline')).toBe('empty')
    expect(effectiveState('architecture')).toBe('normal')
  })

  it('clears an override by setting it back to normal', () => {
    setSurfaceState('telemetry', 'error')
    expect(effectiveState('telemetry')).toBe('error')
    setSurfaceState('telemetry', 'normal')
    expect(effectiveState('telemetry')).toBe('normal')
  })

  it('resets all overrides', () => {
    setSurfaceState('pipeline', 'loading')
    setSurfaceState('activity', 'error')
    resetSurfaceStates()
    expect(effectiveState('pipeline')).toBe('normal')
    expect(effectiveState('activity')).toBe('normal')
  })
})
