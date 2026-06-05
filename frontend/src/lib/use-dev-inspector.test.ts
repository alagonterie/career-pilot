import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fieldLabel,
  parseList,
  postKnob,
  useDevKnobs,
  useDevState,
  type DevKnobsResponse,
  type DevStateResponse,
} from './use-dev-inspector'

/** Minimal fetch Response stand-in (mirrors the use-funnel test helper). */
function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDevKnobs', () => {
  it('fetches the knob set from /api/dev/knobs', async () => {
    const body: DevKnobsResponse = {
      knobs: [
        {
          key: 'recruiter_sim_enabled',
          value: false,
          type: 'boolean',
          group: 'sim',
          label: 'Sim enabled',
          min: null,
          max: null,
          integer: false,
          note: null,
        },
      ],
    }
    const fetchMock = vi.fn(async () => res(body))
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => useDevKnobs('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.data?.knobs[0].key).toBe('recruiter_sim_enabled')
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/dev/knobs', expect.anything())
    unmount()
  })

  it('reports error on a cold 404 (non-dev stack)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'not_found' }, false, 404)),
    )
    const { result, unmount } = renderHook(() => useDevKnobs('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.data).toBeNull()
    unmount()
  })
})

describe('useDevState', () => {
  it('fetches the sim state from /api/dev/state', async () => {
    const body: DevStateResponse = { enabled: true, lastSeedAtMs: 1, apps: [], applications: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(body)),
    )
    const { result, unmount } = renderHook(() => useDevState('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.data?.enabled).toBe(true)
    unmount()
  })
})

describe('postKnob', () => {
  it('POSTs { key, value } as JSON and returns ok on 200', async () => {
    const fetchMock = vi.fn(async () => res({ applied: true }, true, 200))
    vi.stubGlobal('fetch', fetchMock)

    const out = await postKnob('http://x', 'recruiter_sim_max_concurrent', 3)
    expect(out).toMatchObject({ ok: true, status: 200 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method?: string; body?: string }]
    expect(url).toBe('http://x/api/dev/knobs')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ key: 'recruiter_sim_max_concurrent', value: 3 })
  })

  it('returns the server error on a 400 rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ error: 'recruiter_sim_max_concurrent must be ≤ 100' }, false, 400)),
    )
    const out = await postKnob('http://x', 'recruiter_sim_max_concurrent', 999)
    expect(out.ok).toBe(false)
    expect(out.status).toBe(400)
    expect(out.error).toContain('≤ 100')
  })

  it('returns ok:false on a network error (no throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      }),
    )
    const out = await postKnob('http://x', 'recruiter_sim_enabled', true)
    expect(out.ok).toBe(false)
    expect(out.status).toBe(0)
  })
})

describe('pure view helpers', () => {
  it('fieldLabel maps onboarding keys to friendly labels', () => {
    expect(fieldLabel('full_name')).toBe('Full name')
    expect(fieldLabel('why_this_exists')).toBe('Why this exists')
    expect(fieldLabel('unknown_key')).toBe('unknown_key')
  })

  it('parseList tolerates null + malformed JSON', () => {
    expect(parseList('["a","b"]')).toEqual(['a', 'b'])
    expect(parseList(null)).toEqual([])
    expect(parseList('not json')).toEqual([])
    expect(parseList('{"x":1}')).toEqual([])
  })
})
