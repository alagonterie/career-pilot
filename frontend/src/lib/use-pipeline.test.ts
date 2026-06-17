import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deriveStatTiles, usePipeline, type PipelineApplication, type PipelineResponse } from './use-pipeline'

function app(p: Partial<PipelineApplication> = {}): PipelineApplication {
  return {
    application_id: 'acme',
    application_ref: 'acme',
    public_state: 'obfuscated',
    role_title: 'Senior Software Engineer',
    status: 'APPLIED',
    stage: 'applied',
    applied_at: '2026-01-10T00:00:00Z',
    stage_entered_at: '2026-01-10T00:00:00Z',
    last_activity_at: null,
    win_confidence: null,
    win_confidence_rationale: null,
    published_learning: null,
    days_in_stage: 3,
    days_in_pipeline: 10,
    ...p,
  }
}

/** Minimal fetch Response stand-in (avoids depending on a global Response). */
function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deriveStatTiles', () => {
  it('derives the four tiles from the rows (date-windowed counts honest)', () => {
    const now = new Date()
    const thisYear = `${now.getUTCFullYear()}-03-02T00:00:00Z`
    const apps = [
      app({ application_ref: 'a', stage: 'offer', applied_at: thisYear, days_in_pipeline: 20 }),
      app({
        application_ref: 'b',
        stage: 'screening',
        applied_at: thisYear,
        stage_entered_at: now.toISOString(),
        days_in_pipeline: 10,
      }),
      app({ application_ref: 'c', stage: 'rejected', applied_at: '2024-02-02T00:00:00Z', days_in_pipeline: 99 }),
    ]

    const byLabel = Object.fromEntries(deriveStatTiles(apps).map((t) => [t.label, t.value]))
    expect(byLabel['Applications YTD']).toBe('2') // a + b this year; c is 2024
    expect(byLabel['Interviews this month']).toBe('1') // b entered screening this month
    expect(byLabel['Offers']).toBe('1') // a
    expect(byLabel['Avg days active']).toBe('15') // (20 + 10) / 2; closed c excluded
  })

  it('returns zeroed tiles for an empty pipeline (no crash)', () => {
    const byLabel = Object.fromEntries(deriveStatTiles([]).map((t) => [t.label, t.value]))
    expect(byLabel['Offers']).toBe('0')
    expect(byLabel['Avg days active']).toBe('0')
  })

  it('every tile carries InfoTip derivation copy with the honest caveats (§24.60)', () => {
    const tiles = deriveStatTiles([])
    for (const t of tiles) expect(t.tip.length).toBeGreaterThan(20)
    const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.tip]))
    expect(byLabel['Applications YTD']).toMatch(/calendar year/i)
    expect(byLabel['Interviews this month']).toMatch(/calendar month/i)
    expect(byLabel['Avg days active']).toMatch(/heuristic/i)
  })
})

describe('usePipeline', () => {
  it('fetches and exposes the pipeline snapshot', async () => {
    const body: PipelineResponse = { applications: [app()], stage_counts: { applied: 1 } }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(body)),
    )

    const { result, unmount } = renderHook(() => usePipeline('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.data?.applications).toHaveLength(1)
    unmount()
  })

  it('reports error on a cold fetch failure (no prior data)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      }),
    )

    const { result, unmount } = renderHook(() => usePipeline('http://x', 10_000))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.data).toBeNull()
    unmount()
  })

  it('re-polls and reflects advanced data', async () => {
    // First poll → 'applied'; every later poll → 'screening'. We assert the
    // durable outcome (a re-poll replaced the data) rather than the transient
    // first state, which a fast poll can overwrite before the assertion runs.
    const first: PipelineResponse = { applications: [app({ stage: 'applied' })], stage_counts: { applied: 1 } }
    const second: PipelineResponse = { applications: [app({ stage: 'screening' })], stage_counts: { screening: 1 } }
    const fetchMock = vi.fn().mockResolvedValueOnce(res(first)).mockResolvedValue(res(second))
    vi.stubGlobal('fetch', fetchMock)

    const { result, unmount } = renderHook(() => usePipeline('http://x', 20))
    await waitFor(() => expect(result.current.data?.applications[0].stage).toBe('screening'))
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    unmount()
  })
})
