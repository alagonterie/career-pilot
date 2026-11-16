import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdminWatchlistBoard, AdminWatchlistView } from '~/lib/use-admin'

import { addBoardNote, agoLabel, WatchlistPanel } from './WatchlistPanel'

// §24.202 D6 — the Watchlist tab: boards, pause / resume / remove, add by URL.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function board(over: Partial<AdminWatchlistBoard> & { id: number; company: string }): AdminWatchlistBoard {
  return {
    ats: 'greenhouse',
    token: over.company.toLowerCase(),
    tier: 'B',
    origin: 'seed',
    state: 'active',
    notes: null,
    last_ok_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    last_error: null,
    consecutive_failures: 0,
    consecutive_absent: 0,
    leads_found: 12,
    last_hit_at: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    open_leads: 4,
    board_url: `https://job-boards.greenhouse.io/${over.company.toLowerCase()}`,
    ...over,
  }
}

const VIEW: AdminWatchlistView = {
  boards: [
    board({ id: 1, company: 'Acme', origin: 'owner' }),
    board({ id: 2, company: 'Globex', state: 'paused', last_error: 'HTTP 500', consecutive_failures: 3 }),
    board({ id: 3, company: 'Initech', state: 'absent', ats: 'lever', last_ok_at: null }),
  ],
  counts: { total: 3, active: 1, paused: 1, absent: 1, by_origin: { seed: 2, owner: 1 } },
  caps: { max_boards: 200, counted: 2, max_auto_adds_per_run: 5 },
}

type Handler = (body: Record<string, unknown>) => { status: number; body: unknown }

function stubApi(handlers: Record<string, Handler> = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const h = handlers[String(body.action)]
    const out = h ? h(body) : { status: 200, body: { ok: true } }
    return new Response(JSON.stringify(out.body), { status: out.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function posted(fetchMock: ReturnType<typeof stubApi>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/admin/watchlist') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

function renderPanel(data: AdminWatchlistView | null = VIEW, onSaved = vi.fn()) {
  render(<WatchlistPanel data={data} knobs={null} baseUrl="http://x" onSaved={onSaved} onKnobsSaved={vi.fn()} />)
  return onSaved
}

function rowOf(company: string): HTMLElement {
  const row = screen.getAllByTestId('watchlist-row').find((r) => r.textContent?.includes(company))
  if (!row) throw new Error(`no row for ${company}`)
  return row
}

describe('WatchlistPanel', () => {
  it('says so before the first read', () => {
    renderPanel(null)
    expect(screen.getByText('No watchlist data yet.')).toBeInTheDocument()
  })

  it('lists every board with origin, state, last fetch, last error and leads found', () => {
    renderPanel()
    expect(screen.getAllByTestId('watchlist-row')).toHaveLength(3)
    const acme = rowOf('Acme')
    expect(within(acme).getByTestId('watchlist-board-link')).toHaveAttribute(
      'href',
      'https://job-boards.greenhouse.io/acme',
    )
    expect(acme).toHaveTextContent('owner')
    expect(within(acme).getByTestId('watchlist-state')).toHaveTextContent('active')
    expect(acme).toHaveTextContent('3h ago')
    expect(within(acme).getByTestId('watchlist-leads')).toHaveTextContent('12 / 4 open')
    expect(within(rowOf('Globex')).getByTestId('watchlist-last-error')).toHaveTextContent('HTTP 500 ×3')
    expect(rowOf('Initech')).toHaveTextContent('never')
  })

  it('shows the counts, the cap as counted / max, and the origin mix', () => {
    renderPanel()
    const counts = screen.getByTestId('watchlist-counts')
    expect(counts).toHaveTextContent('Active1')
    expect(counts).toHaveTextContent('Board cap2 / 200')
    expect(screen.getByTestId('watchlist-by-origin')).toHaveTextContent('seed 2 · owner 1')
  })

  it('renders the table alone when the host omits counts and caps', () => {
    renderPanel({ boards: VIEW.boards })
    expect(screen.queryByTestId('watchlist-counts')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('watchlist-row')).toHaveLength(3)
  })

  it('filters by state', () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('watchlist-filter-state'), { target: { value: 'paused' } })
    expect(screen.getAllByTestId('watchlist-row')).toHaveLength(1)
    expect(screen.getByTestId('watchlist-row')).toHaveTextContent('Globex')
    expect(screen.getByTestId('watchlist-shown')).toHaveTextContent('1 shown')
  })

  it('pauses an active board and resumes a paused or absent one', async () => {
    const f = stubApi({
      set_state: (b) => ({ status: 200, body: { ok: true, board: { ...VIEW.boards[0], state: b.state } } }),
    })
    const onSaved = renderPanel()
    expect(within(rowOf('Acme')).queryByTestId('watchlist-resume')).not.toBeInTheDocument()
    fireEvent.click(within(rowOf('Acme')).getByTestId('watchlist-pause'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    fireEvent.click(within(rowOf('Globex')).getByTestId('watchlist-resume'))
    fireEvent.click(within(rowOf('Initech')).getByTestId('watchlist-resume'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(3))
    expect(posted(f)).toEqual([
      { action: 'set_state', id: 1, state: 'paused' },
      { action: 'set_state', id: 2, state: 'active' },
      { action: 'set_state', id: 3, state: 'active' },
    ])
  })

  it('shows a refused resume inline (cap reached) and does not refresh', async () => {
    stubApi({ set_state: () => ({ status: 409, body: { error: 'cap_reached', cap: 2, counted: 2 } }) })
    const onSaved = renderPanel()
    fireEvent.click(within(rowOf('Initech')).getByTestId('watchlist-resume'))
    expect(await within(rowOf('Initech')).findByTestId('watchlist-row-error')).toHaveTextContent(
      'The watchlist is full (2 of 2 boards).',
    )
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('remove asks first; cancel posts nothing, confirm posts remove', async () => {
    const f = stubApi({ remove: (b) => ({ status: 200, body: { ok: true, id: b.id, removed: true } }) })
    const onSaved = renderPanel()
    const acme = rowOf('Acme')
    fireEvent.click(within(acme).getByTestId('watchlist-remove'))
    expect(within(acme).getByTestId('watchlist-remove-confirm')).toBeInTheDocument()
    fireEvent.click(within(acme).getByTestId('watchlist-remove-cancel'))
    expect(within(acme).queryByTestId('watchlist-remove-confirm')).not.toBeInTheDocument()
    expect(posted(f)).toEqual([])

    fireEvent.click(within(acme).getByTestId('watchlist-remove'))
    fireEvent.click(within(acme).getByTestId('watchlist-remove-yes'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted(f)).toEqual([{ action: 'remove', id: 1 }])
  })

  it('a seed board refuses removal with the host sentence', async () => {
    const msg = 'This board comes from the seed list and would come back on the next restart. Pause it instead.'
    stubApi({ remove: () => ({ status: 409, body: { error: 'seed_board', message: msg } }) })
    const onSaved = renderPanel()
    const globex = rowOf('Globex')
    fireEvent.click(within(globex).getByTestId('watchlist-remove'))
    fireEvent.click(within(globex).getByTestId('watchlist-remove-yes'))
    expect(await within(globex).findByTestId('watchlist-row-error')).toHaveTextContent(msg)
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('WatchlistPanel — add company by URL', () => {
  it('is disabled until a link is typed', () => {
    renderPanel()
    expect(screen.getByTestId('watchlist-add-submit')).toBeDisabled()
  })

  it('adds a board, sending company and tier only when given, then clears the form', async () => {
    const added = board({ id: 9, company: 'Umbrella', origin: 'owner', ats: 'ashby' })
    const f = stubApi({
      add_by_url: () => ({ status: 200, body: { ok: true, board: added, inserted: true, reactivated: false } }),
    })
    const onSaved = renderPanel()
    const url = screen.getByTestId('watchlist-add-url')
    fireEvent.change(url, { target: { value: ' https://jobs.ashbyhq.com/umbrella ' } })
    fireEvent.click(screen.getByTestId('watchlist-add-submit'))
    expect(await screen.findByTestId('watchlist-add-note')).toHaveTextContent(
      'Now watching Umbrella (ashby). The next sweep reads its postings.',
    )
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(url).toHaveValue('')

    fireEvent.change(url, { target: { value: 'https://jobs.ashbyhq.com/umbrella' } })
    fireEvent.change(screen.getByTestId('watchlist-add-company'), { target: { value: 'Umbrella Corp' } })
    fireEvent.change(screen.getByTestId('watchlist-add-tier'), { target: { value: 'A' } })
    fireEvent.click(screen.getByTestId('watchlist-add-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    expect(posted(f)).toEqual([
      { action: 'add_by_url', url: 'https://jobs.ashbyhq.com/umbrella' },
      { action: 'add_by_url', url: 'https://jobs.ashbyhq.com/umbrella', company: 'Umbrella Corp', tier: 'A' },
    ])
  })

  it.each([
    [400, { error: 'url_required', message: 'Paste a board or job link.' }, 'Paste a board or job link.'],
    [
      400,
      {
        error: 'not_board_url',
        message: 'Only Greenhouse, Lever and Ashby links can be added. Other career sites are not fetched.',
      },
      'Only Greenhouse, Lever and Ashby links can be added.',
    ],
    [
      400,
      { error: 'bad_token', message: "That link's board name is not valid." },
      "That link's board name is not valid.",
    ],
    [
      409,
      { error: 'already_listed', board: board({ id: 1, company: 'Acme' }) },
      'Acme is already on the watchlist (active).',
    ],
    [409, { error: 'cap_reached', cap: 200, counted: 200 }, 'The watchlist is full (200 of 200 boards).'],
    [
      404,
      { error: 'board_not_found', message: 'The ATS says that board does not exist.' },
      'The ATS says that board does not exist.',
    ],
    [
      502,
      { error: 'adapter_failed', message: 'The ATS did not answer (HTTP 503).', status: 503 },
      'The ATS did not answer',
    ],
  ])('a %i refusal shows its message inline and keeps the link', async (status, body, text) => {
    stubApi({ add_by_url: () => ({ status, body }) })
    const onSaved = renderPanel()
    fireEvent.change(screen.getByTestId('watchlist-add-url'), { target: { value: 'https://example.com/careers' } })
    fireEvent.click(screen.getByTestId('watchlist-add-submit'))
    expect(await screen.findByTestId('watchlist-add-error')).toHaveTextContent(text)
    expect(screen.getByTestId('watchlist-add-url')).toHaveValue('https://example.com/careers')
    expect(screen.queryByTestId('watchlist-add-note')).not.toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('WatchlistPanel helpers', () => {
  it('addBoardNote words inserted, reactivated and neither', () => {
    const b = board({ id: 1, company: 'Acme' })
    expect(addBoardNote(b, false, true)).toBe('Acme was marked absent and is back on the watchlist.')
    expect(addBoardNote(b, true, false)).toMatch(/^Now watching Acme \(greenhouse\)/)
    expect(addBoardNote(b, false, false)).toBe('Acme is on the watchlist.')
  })

  it('agoLabel', () => {
    const now = Date.parse('2026-11-16T12:00:00Z')
    expect(agoLabel(null, now)).toBe('never')
    expect(agoLabel('garbage', now)).toBe('—')
    expect(agoLabel('2026-11-16T11:30:00Z', now)).toBe('just now')
    expect(agoLabel('2026-11-16T07:00:00Z', now)).toBe('5h ago')
    expect(agoLabel('2026-11-13T12:00:00Z', now)).toBe('3d ago')
  })
})
