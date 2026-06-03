import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSanitizeDemo } from './use-sanitize-demo'

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}
const demo = (sample: number, total = 3) => ({
  raw: `raw-${sample}`,
  sanitized: `san-${sample}`,
  redactions: 4,
  sample,
  total,
})

afterEach(() => vi.restoreAllMocks())

describe('useSanitizeDemo', () => {
  it('POSTs and exposes sample 0 on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(demo(0))),
    )
    const { result, unmount } = renderHook(() => useSanitizeDemo('http://x'))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.data?.sample).toBe(0)
    unmount()
  })

  it('showAnother advances the sample and re-fetches with the new index', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(demo(0)))
      .mockResolvedValueOnce(res(demo(1)))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useSanitizeDemo('http://x'))
    await waitFor(() => expect(result.current.data?.sample).toBe(0))

    act(() => result.current.showAnother())
    await waitFor(() => expect(result.current.data?.sample).toBe(1))
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(secondBody.sample).toBe(1)
    unmount()
  })

  it('reports error on a cold fetch failure (no prior data)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      }),
    )
    const { result, unmount } = renderHook(() => useSanitizeDemo('http://x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.data).toBeNull()
    unmount()
  })
})
