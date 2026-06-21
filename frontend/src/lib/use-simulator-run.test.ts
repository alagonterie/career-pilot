import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSimulatorRun } from './use-simulator-run'

// The hook drives the run by POSTing then delegating the live stream to
// connectSimulatorStream — mock that boundary so each test scripts the events.
vi.mock('./sse', () => ({ connectSimulatorStream: vi.fn() }))
import { connectSimulatorStream } from './sse'

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(connectSimulatorStream).mockReset()
})

describe('useSimulatorRun', () => {
  it('runs the happy path: POST → running → streamed trace/output → done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ simulation_id: 'sb-abc123' })),
    )
    vi.mocked(connectSimulatorStream).mockImplementation(async (opts) => {
      opts.onEvent({ event: 'trace', data: JSON.stringify({ t: 'subagent', subagent: 'research-company' }) })
      opts.onEvent({
        event: 'trace',
        data: JSON.stringify({ t: 'tool', name: 'web_search', parent_tool_use_id: 'tu' }),
      })
      opts.onEvent({ event: 'chat', data: JSON.stringify({ text: '## Tailored resume\n- a bullet' }) })
      opts.onEvent({ event: 'chat', data: JSON.stringify({ text: '## Cold outreach\nHi there' }) })
      opts.onEvent({ event: 'trace', data: JSON.stringify({ t: 'result', cost_usd: 0.041 }) })
      opts.onEvent({ event: 'end', data: JSON.stringify({ reason: 'complete', cost_usd: 0.041, latency_ms: 1200 }) })
    })

    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme Corp', role: 'Staff Engineer' }))

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.runId).toBe('sb-abc123')
    // The `result` trace is captured into cost, not pushed as a dispatch line.
    expect(result.current.trace).toHaveLength(2)
    expect(result.current.cost_usd).toBeCloseTo(0.041)
    expect(result.current.output).toContain('Tailored resume')
    expect(result.current.output).toContain('Cold outreach')
    expect(result.current.elapsedMs).not.toBeNull()
  })

  it('goes to a generic `unavailable` on a reasonless 503 and never opens a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'UNAVAILABLE' }, false, 503)),
    )

    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.degradeReason).toBeNull()
    expect(connectSimulatorStream).not.toHaveBeenCalled()
  })

  it('brands a 503 kill switch as the `disabled` degradation (§24.150)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'UNAVAILABLE', reason: 'simulator_disabled' }, false, 503)),
    )
    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.degradeReason).toBe('disabled')
  })

  it('brands a 429 global-budget cap as the `budget` degradation (§24.150)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'RATE_LIMITED', reason: 'budget_exceeded' }, false, 429)),
    )
    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.degradeReason).toBe('budget')
    expect(connectSimulatorStream).not.toHaveBeenCalled()
  })

  it('brands a 429 per-IP cap as the `rate_limit` degradation, and defaults a reasonless 429 to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'RATE_LIMITED', reason: 'rate_limited_ip' }, false, 429)),
    )
    const a = renderHook(() => useSimulatorRun())
    act(() => a.result.current.start({ company: 'Acme', role: 'SWE' }))
    await waitFor(() => expect(a.result.current.status).toBe('unavailable'))
    expect(a.result.current.degradeReason).toBe('rate_limit')

    // A 429 with no `reason` is still always a cap → default to the per-IP variant.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'RATE_LIMITED' }, false, 429)),
    )
    const b = renderHook(() => useSimulatorRun())
    act(() => b.result.current.start({ company: 'Acme', role: 'SWE' }))
    await waitFor(() => expect(b.result.current.status).toBe('unavailable'))
    expect(b.result.current.degradeReason).toBe('rate_limit')
  })

  it('goes to `error` when the POST cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorMessage).toBeTruthy()
  })

  it('shows a timeout error on a hard-wall `end` with no output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ simulation_id: 'sb-wall' })),
    )
    vi.mocked(connectSimulatorStream).mockImplementation(async (opts) => {
      opts.onEvent({ event: 'trace', data: JSON.stringify({ t: 'subagent', subagent: 'research-company' }) })
      opts.onEvent({ event: 'end', data: JSON.stringify({ reason: 'hard-wall', latency_ms: 300000 }) })
    })

    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorMessage).toContain('timed out')
  })

  it('still reaches done on a hard-wall `end` when partial output exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ simulation_id: 'sb-partial' })),
    )
    vi.mocked(connectSimulatorStream).mockImplementation(async (opts) => {
      opts.onEvent({ event: 'chat', data: JSON.stringify({ text: 'partial bullets' }) })
      opts.onEvent({ event: 'end', data: JSON.stringify({ reason: 'hard-wall', latency_ms: 300000 }) })
    })

    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.output).toContain('partial bullets')
  })

  it('reset() returns to the idle input state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ simulation_id: 'sb-x' })),
    )
    vi.mocked(connectSimulatorStream).mockImplementation(async (opts) => {
      opts.onEvent({ event: 'chat', data: JSON.stringify({ text: 'done' }) })
      opts.onEvent({ event: 'end', data: JSON.stringify({ reason: 'complete', latency_ms: 800 }) })
    })

    const { result } = renderHook(() => useSimulatorRun())
    act(() => result.current.start({ company: 'Acme', role: 'SWE' }))
    await waitFor(() => expect(result.current.status).toBe('done'))

    act(() => result.current.reset())
    expect(result.current.status).toBe('idle')
    expect(result.current.trace).toHaveLength(0)
    expect(result.current.output).toBe('')
    expect(result.current.runId).toBeNull()
  })
})
