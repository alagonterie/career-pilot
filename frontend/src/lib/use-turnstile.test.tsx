import { act, render, renderHook, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the real widget — Cloudflare's script can't load in jsdom. The stub
// captures the callbacks the hook wires and exposes a spy for the imperative
// `reset()`, so tests can drive the solve / error / reset lifecycle (§24.200).
interface StubProps {
  onSuccess?: (token: string) => void
  onError?: () => void
  onExpire?: () => void
}
const stub = vi.hoisted(() => ({ props: null as StubProps | null, reset: vi.fn() }))

vi.mock('@marsidev/react-turnstile', async () => {
  const R = await import('react')
  return {
    Turnstile: R.forwardRef<{ reset: () => void }, StubProps>((props, ref) => {
      stub.props = props
      R.useImperativeHandle(ref, () => ({ reset: stub.reset }))
      return null
    }),
  }
})

async function loadHook(siteKey: string) {
  vi.resetModules()
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', siteKey)
  return (await import('./use-turnstile')).useTurnstile
}

const REAL_KEY = '0x4AAAAAAAAAAAAAAAAAAAAA'
const TEST_KEY = '1x00000000000000000000AA'

/** Mounts the hook's widget + hint the way a form does, exposing the live state. */
async function mountHarness(siteKey: string) {
  const useTurnstile = await loadHook(siteKey)
  const state: { current: ReturnType<typeof useTurnstile> | null } = { current: null }
  function Harness(): React.ReactNode {
    const t = useTurnstile('contact_submit')
    state.current = t
    return (
      <>
        {t.widget}
        {t.hint}
      </>
    )
  }
  render(<Harness />)
  return state as { current: ReturnType<typeof useTurnstile> }
}

afterEach(() => {
  vi.unstubAllEnvs()
  stub.props = null
  stub.reset.mockClear()
})

describe('useTurnstile (§24.70 D5)', () => {
  it('renders no widget and does not enforce when no site key is set (local/tests)', async () => {
    const useTurnstile = await loadHook('')
    const { result } = renderHook(() => useTurnstile('contact_submit'))
    expect(result.current.enforce).toBe(false)
    expect(result.current.widget).toBeNull()
    expect(result.current.status).toBe('off')
    expect(result.current.hint).toBeNull()
  })

  it('renders the widget but does not enforce with the always-pass TEST key (dev)', async () => {
    const useTurnstile = await loadHook(TEST_KEY)
    const { result } = renderHook(() => useTurnstile('contact_submit'))
    expect(result.current.enforce).toBe(false)
    expect(result.current.widget).not.toBeNull()
  })

  it('renders the widget and enforces with a real site key (prod)', async () => {
    const useTurnstile = await loadHook(REAL_KEY)
    const { result } = renderHook(() => useTurnstile('simulator_run'))
    expect(result.current.enforce).toBe(true)
    expect(result.current.widget).not.toBeNull()
  })
})

describe('useTurnstile status + reset (§24.200)', () => {
  it('explains the blocked button while solving, then goes quiet once a token arrives', async () => {
    const state = await mountHarness(REAL_KEY)
    expect(state.current.status).toBe('solving')
    expect(screen.getByTestId('turnstile-hint')).toHaveTextContent(/verifying/i)

    act(() => stub.props?.onSuccess?.('tok-1'))
    expect(state.current.status).toBe('ready')
    expect(state.current.token).toBe('tok-1')
    expect(screen.queryByTestId('turnstile-hint')).toBeNull()
  })

  it('reports a failed solve with an actionable hint, and recovers on a later success', async () => {
    const state = await mountHarness(REAL_KEY)
    act(() => stub.props?.onError?.())
    expect(state.current.status).toBe('failed')
    expect(state.current.token).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(/content blockers/i)

    act(() => stub.props?.onSuccess?.('tok-2'))
    expect(state.current.status).toBe('ready')
    expect(screen.queryByTestId('turnstile-hint')).toBeNull()
  })

  it('reset() discards the spent token, re-runs the widget, and returns to solving', async () => {
    const state = await mountHarness(REAL_KEY)
    act(() => stub.props?.onSuccess?.('tok-1'))
    act(() => state.current.reset())
    expect(stub.reset).toHaveBeenCalledTimes(1)
    expect(state.current.token).toBeNull()
    expect(state.current.status).toBe('solving')
  })

  it('goes back to solving when a token expires', async () => {
    const state = await mountHarness(REAL_KEY)
    act(() => stub.props?.onSuccess?.('tok-1'))
    act(() => stub.props?.onExpire?.())
    expect(state.current.status).toBe('solving')
  })

  it('never shows a hint with the always-pass TEST key — the button is not blocked there', async () => {
    const state = await mountHarness(TEST_KEY)
    expect(state.current.status).toBe('solving')
    expect(screen.queryByTestId('turnstile-hint')).toBeNull()
    act(() => stub.props?.onError?.())
    expect(screen.queryByTestId('turnstile-hint')).toBeNull()
  })
})
