import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useReveal } from './use-reveal'

describe('useReveal — the SSR/no-JS-visible contract (§24.146 A0)', () => {
  it('returns an empty className by default, so the element ships VISIBLE', () => {
    // First render (the SSR + hydration frame): no armed class, ever.
    const { result } = renderHook(() => useReveal())
    expect(result.current.className).toBe('')
    expect(result.current.ref.current).toBeNull()
  })

  it('stays visible after mount when IntersectionObserver is unavailable', () => {
    // jsdom has no IntersectionObserver → the hook must NOT arm (no permanently
    // hidden section), the cp-rise no-JS principle.
    expect('IntersectionObserver' in window).toBe(false)
    const { result } = renderHook(() => useReveal())
    expect(result.current.className).toBe('')
  })
})
