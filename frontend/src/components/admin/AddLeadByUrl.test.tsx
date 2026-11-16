import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AddLeadByUrlResult } from '~/lib/use-admin'

import { AddLeadByUrl, addLeadNote, boardNote, offerWatch } from './AddLeadByUrl'

// §24.202 D7 — "Add lead by URL" on the Leads tab: one input, the host's refusal
// sentences, and a success note that proposes (never auto-adds) the board.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const POSTING = 'https://job-boards.greenhouse.io/acme/jobs/4012345'

function result(over: Partial<AddLeadByUrlResult> = {}, board: Partial<AddLeadByUrlResult['board_proposed']> = {}) {
  return {
    ok: true as const,
    lead_id: 'lead-9',
    outcome: 'created' as const,
    lead_status: 'new',
    tombstone_cleared: false,
    ...over,
    board_proposed: {
      ats: 'greenhouse' as const,
      token: 'acme',
      company: 'Acme',
      already_listed: false,
      state: null,
      ...board,
    },
  }
}

type Reply = { status: number; body: unknown }

function stubApi(leads: () => Reply, watchlist: () => Reply = () => ({ status: 200, body: { ok: true } })) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const out = String(url).endsWith('/api/admin/watchlist') ? watchlist() : leads()
    return new Response(JSON.stringify(out.body), { status: out.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodies(fetchMock: ReturnType<typeof stubApi>, path: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(path))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

function submit(url = POSTING) {
  fireEvent.change(screen.getByTestId('leads-add-url-input'), { target: { value: url } })
  fireEvent.click(screen.getByTestId('leads-add-url-submit'))
}

describe('AddLeadByUrl', () => {
  it('is one input whose button stays disabled until a link is typed', () => {
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Add lead by link')).toBe(screen.getByTestId('leads-add-url-input'))
    expect(screen.getByTestId('leads-add-url-submit')).toBeDisabled()
  })

  it('adds the lead, refreshes, clears the input, and offers to watch an unlisted board', async () => {
    const f = stubApi(() => ({ status: 200, body: result() }))
    const onSaved = vi.fn()
    render(<AddLeadByUrl baseUrl="http://x" onSaved={onSaved} />)
    submit()
    expect(await screen.findByTestId('leads-add-url-note')).toHaveTextContent(/^Lead added\.$/)
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('leads-add-url-input')).toHaveValue('')
    expect(bodies(f, '/api/admin/leads')).toEqual([{ action: 'add_lead_by_url', url: POSTING }])
    expect(screen.queryByTestId('leads-add-url-board')).not.toBeInTheDocument()
    expect(screen.getByTestId('leads-add-url-watch')).toHaveTextContent("Watch Acme's board")
  })

  it('"Watch this board" adds it with the same posting link and the proposed company', async () => {
    const f = stubApi(
      () => ({ status: 200, body: result() }),
      () => ({
        status: 200,
        body: { ok: true, board: { id: 4, company: 'Acme', ats: 'greenhouse' }, inserted: true, reactivated: false },
      }),
    )
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    submit()
    fireEvent.click(await screen.findByTestId('leads-add-url-watch'))
    expect(await screen.findByTestId('leads-add-url-watch-note')).toHaveTextContent("Now watching Acme's board.")
    expect(screen.queryByTestId('leads-add-url-watch')).not.toBeInTheDocument()
    expect(bodies(f, '/api/admin/watchlist')).toEqual([{ action: 'add_by_url', url: POSTING, company: 'Acme' }])
  })

  it('a refused watch shows its sentence and keeps the button', async () => {
    stubApi(
      () => ({ status: 200, body: result() }),
      () => ({ status: 409, body: { error: 'cap_reached', cap: 200, counted: 200 } }),
    )
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    submit()
    fireEvent.click(await screen.findByTestId('leads-add-url-watch'))
    expect(await screen.findByTestId('leads-add-url-watch-error')).toHaveTextContent('The watchlist is full')
    expect(screen.getByTestId('leads-add-url-watch')).toBeInTheDocument()
  })

  it('says the board is already watched and offers nothing more', async () => {
    stubApi(() => ({ status: 200, body: result({}, { already_listed: true, state: 'active' }) }))
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    submit()
    expect(await screen.findByTestId('leads-add-url-board')).toHaveTextContent(
      "Acme's board is already on the watchlist (active).",
    )
    expect(screen.queryByTestId('leads-add-url-watch')).not.toBeInTheDocument()
  })

  it('an already-present lead and a cleared tombstone are said plainly', async () => {
    stubApi(() => ({ status: 200, body: result({ outcome: 'already_present', lead_status: 'archived' }) }))
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    submit()
    expect(await screen.findByTestId('leads-add-url-note')).toHaveTextContent('Already in the pool — archived.')
  })

  it.each([
    [400, 'url_required', 'Paste a job posting link.'],
    [400, 'not_posting_url', 'Only Greenhouse, Lever and Ashby job links can be added. Other sites are not fetched.'],
    [400, 'not_posting_url', 'That is a board link, not a job posting. Add the board on the Watchlist tab instead.'],
    [400, 'bad_token', "That link's board name is not valid."],
    [404, 'board_not_found', 'The ATS says that board does not exist.'],
    [404, 'posting_not_found', 'That posting is not on the board any more.'],
    [502, 'adapter_failed', 'The ATS did not answer (HTTP 503).'],
  ])('a %i %s refusal shows the sentence and keeps the link', async (status, error, message) => {
    stubApi(() => ({ status, body: { error, message } }))
    const onSaved = vi.fn()
    render(<AddLeadByUrl baseUrl="http://x" onSaved={onSaved} />)
    submit('https://careers.example.com/jobs/1')
    expect(await screen.findByTestId('leads-add-url-error')).toHaveTextContent(message)
    expect(screen.getByTestId('leads-add-url-input')).toHaveValue('https://careers.example.com/jobs/1')
    expect(screen.queryByTestId('leads-add-url-result')).not.toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('an older host (unknown action) gets a plain sentence', async () => {
    stubApi(() => ({ status: 400, body: { error: 'unknown action: add_lead_by_url' } }))
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    submit()
    expect(await screen.findByTestId('leads-add-url-error')).toHaveTextContent('This server does not support that yet')
  })

  it('a new submit clears the previous result', async () => {
    let n = 0
    stubApi(() =>
      n++ === 0 ? { status: 200, body: result() } : { status: 400, body: { error: 'bad_token', message: 'bad' } },
    )
    render(<AddLeadByUrl baseUrl="http://x" onSaved={vi.fn()} />)
    submit()
    await screen.findByTestId('leads-add-url-result')
    submit()
    await waitFor(() => expect(screen.queryByTestId('leads-add-url-result')).not.toBeInTheDocument())
    expect(screen.getByTestId('leads-add-url-error')).toHaveTextContent('bad')
  })
})

describe('AddLeadByUrl helpers', () => {
  it('addLeadNote', () => {
    expect(addLeadNote(result())).toBe('Lead added.')
    expect(addLeadNote(result({ tombstone_cleared: true }))).toBe(
      'Lead added. Your earlier “not interested” on this posting was cleared.',
    )
    expect(addLeadNote(result({ outcome: 'already_present', lead_status: 'new' }))).toBe('Already in the pool — new.')
  })

  it('boardNote / offerWatch: watch is offered when unlisted or absent', () => {
    const b = result().board_proposed
    expect(boardNote(b)).toBeNull()
    expect(offerWatch(b)).toBe(true)
    expect(offerWatch({ ...b, already_listed: true, state: 'paused' })).toBe(false)
    expect(offerWatch({ ...b, already_listed: true, state: 'absent' })).toBe(true)
    expect(boardNote({ ...b, already_listed: true, state: 'paused' })).toBe(
      "Acme's board is already on the watchlist (paused).",
    )
  })
})
