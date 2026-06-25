import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisitBeacon } from './use-visit-beacon'

/**
 * The first-party visit beacon (§24.177 D2). Fires `POST /api/visit` once, only
 * when the page loaded with a slug-shaped `?from=`; guards against a re-fire via
 * sessionStorage; never throws on a fetch failure. The server allow-lists + dedups
 * — this just covers the client-side firing contract.
 */

const API = 'https://hire.example.com'

function withSearch(search: string): void {
  // jsdom lets us set the URL; the hook reads window.location.search.
  window.history.replaceState({}, '', `/${search}`)
}

function fetchSpy(): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', f)
  return f
}

beforeEach(() => {
  window.sessionStorage.clear()
  withSearch('')
})
afterEach(() => vi.unstubAllGlobals())

describe('useVisitBeacon', () => {
  it('fires once with the slug when ?from= is a known shape', () => {
    withSearch('?from=my_linkedin')
    const f = fetchSpy()
    renderHook(() => useVisitBeacon(API))
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API}/api/visit`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ from: 'my_linkedin' })
  })

  it('does NOT fire when there is no ?from=', () => {
    const f = fetchSpy()
    renderHook(() => useVisitBeacon(API))
    expect(f).not.toHaveBeenCalled()
  })

  it('does NOT fire for a malformed slug (spoof-shaped values never beacon)', () => {
    withSearch('?from=Bad%20Slug!')
    const f = fetchSpy()
    renderHook(() => useVisitBeacon(API))
    expect(f).not.toHaveBeenCalled()
  })

  it('fires once per source per session (a remount does not re-beacon)', () => {
    withSearch('?from=conf_talk')
    const f = fetchSpy()
    renderHook(() => useVisitBeacon(API)).unmount()
    renderHook(() => useVisitBeacon(API))
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('swallows a fetch rejection (a beacon never surfaces to the page)', () => {
    withSearch('?from=ok_src')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(() => renderHook(() => useVisitBeacon(API))).not.toThrow()
  })
})
