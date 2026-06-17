import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useActivityStream } from './use-activity-stream'

// Capture the connect opts (hoisted so the vi.mock factory can reach it) so each
// test can drive onEvent/onStatus directly — no network, no SSE wire.
const h = vi.hoisted(() => ({
  captured: null as null | { onEvent: (e: { data: string }) => void; onStatus?: (s: string) => void },
}))

vi.mock('./sse', () => ({
  connectActivityStream: vi.fn(
    async (opts: { onEvent: (e: { data: string }) => void; onStatus?: (s: string) => void }) => {
      h.captured = opts
      opts.onStatus?.('open')
    },
  ),
}))

const frame = (row: Record<string, unknown>) => ({ data: JSON.stringify(row) })

describe('useActivityStream', () => {
  beforeEach(() => {
    h.captured = null
    vi.clearAllMocks()
  })

  it('excludes the given categories before capping — the home ticker drops turns', async () => {
    const { result } = renderHook(() => useActivityStream('http://x', { exclude: ['turn'], limit: 5 }))
    await waitFor(() => expect(h.captured).not.toBeNull())
    act(() => {
      h.captured!.onEvent(frame({ seq: 1, category: 'pipeline', summary: 'a' }))
      h.captured!.onEvent(frame({ seq: 2, category: 'turn', summary: 'turn complete' }))
      h.captured!.onEvent(frame({ seq: 3, category: 'turn', summary: 'turn complete' }))
      h.captured!.onEvent(frame({ seq: 4, category: 'subagent_progress', summary: 'b' }))
    })
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 4]) // turns dropped
    expect(result.current.count).toBe(2) // excluded rows don't count toward the live indicator
  })

  it('keeps every category when no exclude is given (the /live stream wants turns)', async () => {
    const { result } = renderHook(() => useActivityStream('http://x', { limit: 5 }))
    await waitFor(() => expect(h.captured).not.toBeNull())
    act(() => {
      h.captured!.onEvent(frame({ seq: 1, category: 'pipeline', summary: 'a' }))
      h.captured!.onEvent(frame({ seq: 2, category: 'turn', summary: 'turn complete' }))
    })
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('caps to the most recent `limit` events after excluding', async () => {
    const { result } = renderHook(() => useActivityStream('http://x', { exclude: ['turn'], limit: 2 }))
    await waitFor(() => expect(h.captured).not.toBeNull())
    act(() => {
      for (let seq = 1; seq <= 4; seq++) h.captured!.onEvent(frame({ seq, category: 'pipeline', summary: `a${seq}` }))
    })
    expect(result.current.events.map((e) => e.seq)).toEqual([3, 4]) // oldest two dropped by the cap
  })
})
