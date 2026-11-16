import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  adminRefusalMessage,
  postAddLeadByUrl,
  postSweepPreview,
  postWatchlistAddByUrl,
  type AdminWatchlistBoard,
  type SweepFilterPreview,
} from './use-admin'

// §24.201 D6/D7 — the watchlist + add-by-URL helpers map every contract
// response to a discriminated outcome with a plain sentence.

afterEach(() => {
  vi.unstubAllGlobals()
})

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sentBody(fetchMock: ReturnType<typeof respond>): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> }
}

const BOARD: AdminWatchlistBoard = {
  id: 7,
  ats: 'lever',
  token: 'acme',
  company: 'Acme',
  tier: 'B',
  origin: 'owner',
  state: 'active',
  notes: null,
  last_ok_at: null,
  last_error: null,
  consecutive_failures: 0,
  consecutive_absent: 0,
  leads_found: 0,
  last_hit_at: null,
  created_at: '2026-11-16T00:00:00Z',
  updated_at: '2026-11-16T00:00:00Z',
  open_leads: 0,
  board_url: 'https://jobs.lever.co/acme',
}

describe('postWatchlistAddByUrl', () => {
  it('posts add_by_url to the watchlist route and maps success', async () => {
    const f = respond(200, { ok: true, board: BOARD, inserted: true, reactivated: false })
    const out = await postWatchlistAddByUrl('http://x', { url: 'https://jobs.lever.co/acme', tier: 'A' })
    expect(sentBody(f)).toEqual({
      url: 'http://x/api/admin/watchlist',
      body: { action: 'add_by_url', url: 'https://jobs.lever.co/acme', tier: 'A' },
    })
    expect(out).toEqual({ kind: 'ok', board: BOARD, inserted: true, reactivated: false })
  })

  it.each([
    [400, { error: 'url_required', message: 'Paste a board or job link.' }, 'Paste a board or job link.'],
    [
      400,
      {
        error: 'not_board_url',
        message: 'Only Greenhouse, Lever and Ashby links can be added. Other career sites are not fetched.',
      },
      'Only Greenhouse, Lever and Ashby links can be added. Other career sites are not fetched.',
    ],
    [
      400,
      { error: 'bad_token', message: "That link's board name is not valid." },
      "That link's board name is not valid.",
    ],
    [400, { error: 'bad_company' }, 'The company name must be 1–200 characters.'],
    [400, { error: 'bad_tier' }, 'Tier must be A, B or C.'],
    [
      409,
      { error: 'already_listed', board: { ...BOARD, state: 'paused' } },
      'Acme is already on the watchlist (paused).',
    ],
    [
      409,
      { error: 'cap_reached', cap: 200, counted: 200 },
      'The watchlist is full (200 of 200 boards). Remove a board, or raise the board cap on the System tab.',
    ],
    [
      404,
      { error: 'board_not_found', message: 'The ATS says that board does not exist.' },
      'The ATS says that board does not exist.',
    ],
    [502, { error: 'adapter_failed', message: 'HTTP 503 from the ATS', status: 503 }, 'HTTP 503 from the ATS'],
    [
      400,
      { error: 'unknown action: add_by_url' },
      'This server does not support that yet — deploy the latest backend first.',
    ],
  ])('a %i %j refusal reads "%s"', async (status, body, message) => {
    respond(status, body)
    const out = await postWatchlistAddByUrl('http://x', { url: 'u' })
    expect(out).toEqual({ kind: 'refused', status, error: body.error, message })
  })

  it('a network failure is a refusal with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const out = await postWatchlistAddByUrl('http://x', { url: 'u' })
    expect(out).toEqual({ kind: 'refused', status: 0, error: 'offline', message: 'Network error: offline' })
  })
})

describe('adminRefusalMessage', () => {
  it('uses the seed_board message verbatim and words not_found', () => {
    const seed = 'This board comes from the seed list and would come back on the next restart. Pause it instead.'
    expect(
      adminRefusalMessage({
        ok: false,
        status: 409,
        error: 'seed_board',
        data: { error: 'seed_board', message: seed },
      }),
    ).toBe(seed)
    expect(
      adminRefusalMessage({ ok: false, status: 404, error: 'not_found', data: { error: 'not_found', id: 3 } }),
    ).toBe('That board is no longer on the watchlist.')
  })

  it('puts the host codes that carry no message into words (500 internal_error, 404 not migrated)', () => {
    expect(
      adminRefusalMessage({ ok: false, status: 500, error: 'internal_error', data: { error: 'internal_error' } }),
    ).toBe('The server hit an error, so nothing was changed. Try again; if it keeps happening, check the host logs.')
    for (const error of ['ats_watchlist not migrated', 'job_leads not migrated']) {
      expect(adminRefusalMessage({ ok: false, status: 404, error, data: { error } })).toBe(
        'This server does not support that yet — deploy the latest backend first.',
      )
    }
  })
})

const PREVIEW: SweepFilterPreview = {
  ok: true,
  total: 10,
  current: { keep: 8, drop: 2, drop_by_reason: { filter: 2 } },
  proposed: { keep: 6, drop: 4, drop_by_reason: { filter: 3, age: 1 } },
  newly_dropped: 2,
  newly_kept: 0,
  sample_newly_dropped: [{ id: 'l1', title: 'Sales Engineer', company: 'Globex', reason: 'filter' }],
  sample_newly_kept: [],
}

describe('postSweepPreview', () => {
  it('posts preview_filters with the proposal and returns the preview', async () => {
    const f = respond(200, PREVIEW)
    const out = await postSweepPreview('http://x', { ats_sweep_max_age_days: 14 })
    expect(sentBody(f).body).toEqual({ action: 'preview_filters', filters: { ats_sweep_max_age_days: 14 } })
    expect(out).toEqual({ kind: 'ok', preview: PREVIEW })
  })

  it('maps invalid_filter to the field and the host message', async () => {
    respond(400, {
      error: 'invalid_filter',
      field: 'ats_sweep_title_include',
      message: 'ats_sweep_title_include is not a valid regular expression: Unterminated group',
    })
    expect(await postSweepPreview('http://x', { ats_sweep_title_include: '(' })).toEqual({
      kind: 'invalid',
      field: 'ats_sweep_title_include',
      message: 'ats_sweep_title_include is not a valid regular expression: Unterminated group',
    })
  })

  it('an older host (unknown action, or no watchlist route) is unsupported', async () => {
    respond(400, { error: 'unknown action: preview_filters' })
    expect(await postSweepPreview('http://x', {})).toEqual({ kind: 'unsupported' })
    respond(404, { error: 'not_found' })
    expect(await postSweepPreview('http://x', {})).toEqual({ kind: 'unsupported' })
  })

  it('any other failure is an error with a sentence', async () => {
    respond(500, { error: 'boom' })
    expect(await postSweepPreview('http://x', {})).toEqual({ kind: 'error', status: 500, message: 'boom' })
  })
})

describe('postAddLeadByUrl', () => {
  const OK = {
    ok: true,
    lead_id: 'lead-9',
    outcome: 'created',
    lead_status: 'new',
    tombstone_cleared: false,
    board_proposed: { ats: 'greenhouse', token: 'acme', company: 'Acme', already_listed: false, state: null },
  }

  it('posts add_lead_by_url to the leads route; a blank company is left out', async () => {
    const f = respond(200, OK)
    const out = await postAddLeadByUrl('http://x', 'https://job-boards.greenhouse.io/acme/jobs/1', '  ')
    expect(sentBody(f)).toEqual({
      url: 'http://x/api/admin/leads',
      body: { action: 'add_lead_by_url', url: 'https://job-boards.greenhouse.io/acme/jobs/1' },
    })
    expect(out).toEqual({ kind: 'ok', result: OK })
  })

  it('sends a given company trimmed', async () => {
    const f = respond(200, OK)
    await postAddLeadByUrl('http://x', 'u', ' Acme ')
    expect(sentBody(f).body).toEqual({ action: 'add_lead_by_url', url: 'u', company: 'Acme' })
  })

  it.each([
    [400, 'url_required', 'Paste a job posting link.'],
    [400, 'not_posting_url', 'Only Greenhouse, Lever and Ashby job links can be added. Other sites are not fetched.'],
    [400, 'not_posting_url', 'That is a board link, not a job posting. Add the board on the Watchlist tab instead.'],
    [400, 'bad_token', "That link's board name is not valid."],
    [404, 'board_not_found', 'The ATS says that board does not exist.'],
    [404, 'posting_not_found', 'That posting is not on the board any more.'],
    [502, 'adapter_failed', 'HTTP 500 from the ATS'],
  ])('a %i %s refusal shows the host sentence', async (status, error, message) => {
    respond(status, { error, message })
    expect(await postAddLeadByUrl('http://x', 'u')).toEqual({ kind: 'refused', status, error, message })
  })
})
