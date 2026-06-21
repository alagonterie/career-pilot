import { describe, expect, it } from 'vitest'

import { normalizeLifecycle } from './use-lifecycle'

describe('normalizeLifecycle (§24.149 L2)', () => {
  it('passes the explicit concluded state through', () => {
    expect(normalizeLifecycle('concluded')).toBe('concluded')
  })

  it('fails safe to active for active / absent / junk (an older backend or a bad value)', () => {
    expect(normalizeLifecycle('active')).toBe('active')
    expect(normalizeLifecycle(undefined)).toBe('active')
    expect(normalizeLifecycle(null)).toBe('active')
    expect(normalizeLifecycle('garbage')).toBe('active')
  })
})
