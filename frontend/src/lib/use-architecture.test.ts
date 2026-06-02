import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useArchitecture, type ArchitectureData, type SystemMode } from './use-architecture'

const ARCH: ArchitectureData = {
  sessions: { active: 2, running: 2 },
  containers: { running: 2, capacity_max: 4, memory_mb_each: 512, runtime: 'up' },
  backend: 'online',
}
const MODE: SystemMode = { live_mode: true, pause_state: 'active', pause_reason: null, backend: 'online' }

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useArchitecture', () => {
  it('merges both endpoints into arch + mode and reports ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (String(url).includes('/api/system-status') ? res(MODE) : res(ARCH))),
    )

    const { result, unmount } = renderHook(() => useArchitecture('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.arch?.containers.runtime).toBe('up')
    expect(result.current.mode?.pause_state).toBe('active')
    unmount()
  })

  it('reports error when both feeds cold-fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      }),
    )

    const { result, unmount } = renderHook(() => useArchitecture('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.arch).toBeNull()
    expect(result.current.mode).toBeNull()
    unmount()
  })
})
