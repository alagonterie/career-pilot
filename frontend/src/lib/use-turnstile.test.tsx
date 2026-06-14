import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the real widget — we assert on the enforce/widget-presence resolution
// (D5), not on Cloudflare's script (which can't load in jsdom).
vi.mock('@marsidev/react-turnstile', () => ({ Turnstile: () => null }))

async function loadHook(siteKey: string) {
  vi.resetModules()
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', siteKey)
  return (await import('./use-turnstile')).useTurnstile
}

afterEach(() => vi.unstubAllEnvs())

describe('useTurnstile (§24.70 D5)', () => {
  it('renders no widget and does not enforce when no site key is set (local/tests)', async () => {
    const useTurnstile = await loadHook('')
    const { result } = renderHook(() => useTurnstile('contact_submit'))
    expect(result.current.enforce).toBe(false)
    expect(result.current.widget).toBeNull()
  })

  it('renders the widget but does not enforce with the always-pass TEST key (dev)', async () => {
    const useTurnstile = await loadHook('1x00000000000000000000AA')
    const { result } = renderHook(() => useTurnstile('contact_submit'))
    expect(result.current.enforce).toBe(false)
    expect(result.current.widget).not.toBeNull()
  })

  it('renders the widget and enforces with a real site key (prod)', async () => {
    const useTurnstile = await loadHook('0x4AAAAAAAAAAAAAAAAAAAAA')
    const { result } = renderHook(() => useTurnstile('simulator_run'))
    expect(result.current.enforce).toBe(true)
    expect(result.current.widget).not.toBeNull()
  })
})
