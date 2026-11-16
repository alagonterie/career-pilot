import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminLead, AdminLeadsView } from '~/lib/use-admin'

import { bulkArchiveNote, bulkDeleteNote, LeadsPanel, linkKindOf, resetLeadsVisitSessionForTests } from './LeadsPanel'

// The "new since last visit" baseline is per browser session — start every test
// in a fresh one.
beforeEach(() => {
  resetLeadsVisitSessionForTests()
  try {
    window.sessionStorage.clear()
  } catch {
    // ignore
  }
})

function lead(over: Partial<AdminLead> & { id: string; company: string; rules_score: number }): AdminLead {
  return {
    source: 'greenhouse',
    source_url: `https://x/${over.id}`,
    apply_url: null,
    title: 'Senior Software Engineer',
    company_domain: null,
    location_raw: 'Remote',
    is_remote: 1,
    workplace_type: 'remote',
    comp_min_usd: null,
    comp_max_usd: null,
    comp_currency: 'USD',
    comp_period: null,
    rules_score_reasons: {},
    llm_score: null,
    llm_scored_at: null,
    status: 'new',
    status_changed_at: '2026-06-24T00:00:00Z',
    first_seen_at: '2026-06-24T00:00:00Z',
    last_seen_at: '2026-06-24T00:00:00Z',
    source_posted_at: '2026-06-24T00:00:00Z',
    closed_at: null,
    closed_reason: null,
    killer_match_pushed_at: null,
    application_id: null,
    apply_link_kind: 'ats',
    snippet: null,
    ...over,
  }
}

const DATA: AdminLeadsView = {
  rollup: {
    activeTotal: 2,
    closedTotal: 1,
    byStatus: { new: 1, reviewed: 1 },
    bySource: { greenhouse: 2 },
    llmScored: 1,
    pushed24h: 0,
    added24h: 1,
    added7d: 2,
    newestAgeHours: 5,
  },
  leads: [
    lead({
      id: 'lead-2',
      company: 'Initech',
      rules_score: 40,
      title: 'Backend Engineer',
      is_remote: 0,
      workplace_type: 'onsite',
      location_raw: 'NYC',
      rules_score_reasons: { keyword_match: { score: 15 }, location: { score: -30, off_location: true } },
    }),
    lead({
      id: 'lead-1',
      company: 'Globex',
      rules_score: 82,
      status: 'reviewed',
      llm_score: 74,
      rules_score_reasons: {
        keyword_match: { score: 15, title_hits: 1, desc_hits: 2, matched: ['Go'] },
        comp: { score: 20, floor: 170000 },
        recency: { score: 15, age_hours: 3 },
        source_mult: { source: 'greenhouse', multiplier: 1.1 },
      },
    }),
  ],
  closed: [
    lead({
      id: 'lead-3',
      company: 'Hooli',
      rules_score: 60,
      status: 'archived',
      closed_at: '2026-06-22T00:00:00Z',
      closed_reason: 'stale',
    }),
  ],
}

describe('LeadsPanel', () => {
  it('renders the pool rollup + active leads sorted by rules_score, closed excluded', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByTestId('leads-rollup')).toHaveTextContent('Active')
    const rows = screen.getAllByTestId('leads-row')
    expect(rows).toHaveLength(2) // active only
    // sorted rules_score DESC → Globex (82) before Initech (40)
    expect(within(rows[0]).getByText('Globex')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Initech')).toBeInTheDocument()
    expect(screen.queryByText('Hooli')).not.toBeInTheDocument()
  })

  it('expands a lead to show its rules_score reasons breakdown (the why)', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0]) // Globex
    const reasons = screen.getByTestId('leads-score-reasons')
    expect(reasons).toHaveTextContent('keyword')
    expect(reasons).toHaveTextContent('comp')
    // the triage controls are present in the detail
    expect(screen.getByTestId('leads-status-select')).toBeInTheDocument()
    expect(screen.getByTestId('leads-rescore')).toBeInTheDocument()
  })

  // §24.190 — the aggregator flag carries both the link and the company caveat.
  it('flags an aggregator-only lead as company-unverified in the detail', () => {
    const data: AdminLeadsView = {
      ...DATA,
      leads: [lead({ id: 'agg', company: 'VetsEZ', rules_score: 50, apply_link_kind: 'aggregator' })],
    }
    render(<LeadsPanel data={data} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    expect(screen.getByTestId('leads-link-aggregator')).toHaveTextContent(/company unverified/i)
    expect(screen.queryByTestId('leads-link-direct')).not.toBeInTheDocument()
  })

  it('marks a direct ATS lead as direct', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    expect(screen.getByTestId('leads-link-direct')).toHaveTextContent(/direct ATS link/i)
  })

  it('surfaces the off-location demotion in the reasons breakdown', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[1]) // Initech (off-location)
    expect(screen.getByTestId('leads-score-reasons')).toHaveTextContent('off-location')
  })

  it('include-closed toggle reveals the archived lead', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-row')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('leads-include-closed'))
    expect(screen.getAllByTestId('leads-row')).toHaveLength(3)
    expect(screen.getByText('Hooli')).toBeInTheDocument()
  })

  it('renders the re-score-all action with the active count', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByTestId('leads-rescore-all')).toHaveTextContent('Re-score all active (2)')
  })

  it('explains the status vocabulary via the header InfoTip (incl. the honest "mostly manual" note)', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'About: lead statuses' }))
    const panel = screen.getByTestId('info-tip-panel')
    expect(panel).toHaveTextContent('queued')
    expect(panel).toHaveTextContent('archived')
    expect(panel).toHaveTextContent(/doesn’t advance them on its own|doesn't advance them on its own/)
  })
})

// ── §24.187: the batch-cleanup layer ─────────────────────────────────────────

describe('LeadsPanel — batch cleanup (§24.187)', () => {
  // The fixture leads are first_seen 2026-06-24; pin "now" 10 days later so the
  // age filter has a deterministic boundary to bite on.
  const NOW = new Date('2026-07-04T00:00:00Z')

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function renderPanel(onSaved = vi.fn()) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={onSaved} />)
    return onSaved
  }

  it('shows a bulk bar whose count matches the visible rows', () => {
    renderPanel()
    expect(screen.getAllByTestId('leads-row')).toHaveLength(2)
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('2')
    expect(screen.getByTestId('leads-bulk-archive')).toHaveTextContent('Archive 2')
    expect(screen.getByTestId('leads-bulk-delete')).toHaveTextContent('Delete 2')
  })

  it('the age filter narrows the visible set and the bulk count follows it', () => {
    renderPanel()
    // Everything is 10 days old: "older than 5d" keeps both, "older than 30d" none.
    fireEvent.change(screen.getByTestId('leads-min-age'), { target: { value: '5' } })
    expect(screen.getAllByTestId('leads-row')).toHaveLength(2)
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('2')

    fireEvent.change(screen.getByTestId('leads-min-age'), { target: { value: '30' } })
    expect(screen.queryAllByTestId('leads-row')).toHaveLength(0)
    // no rows → no batch bar at all (nothing to act on)
    expect(screen.queryByTestId('leads-bulk-bar')).not.toBeInTheDocument()
  })

  it('archive is two-step and posts bulk_set_status over exactly the shown ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = renderPanel()

    // First click only arms — nothing is sent.
    fireEvent.click(screen.getByTestId('leads-bulk-archive'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('leads-bulk-archive-confirm')).toHaveTextContent('Confirm archive 2?')

    fireEvent.click(screen.getByTestId('leads-bulk-archive-confirm'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://x/api/admin/leads')
    expect(JSON.parse(String(init.body))).toMatchObject({
      action: 'bulk_set_status',
      status: 'archived',
      ids: ['lead-1', 'lead-2'],
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('delete is two-step, sends confirm:true, and warns that promoted leads are skipped', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    fireEvent.click(screen.getByTestId('leads-bulk-delete'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('leads-bulk-delete-confirm')).toHaveTextContent('Confirm delete 2?')
    expect(screen.getByTestId('leads-bulk-bar')).toHaveTextContent('promoted and email-linked leads are skipped')

    fireEvent.click(screen.getByTestId('leads-bulk-delete-confirm'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({
      action: 'bulk_delete',
      confirm: true,
      ids: ['lead-1', 'lead-2'],
    })
  })

  it('changing a filter disarms an armed confirm (never fires against a different set)', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('leads-bulk-delete'))
    expect(screen.getByTestId('leads-bulk-delete-confirm')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('leads-search'), { target: { value: 'Globex' } })
    expect(screen.queryByTestId('leads-bulk-delete-confirm')).not.toBeInTheDocument()
    expect(screen.getByTestId('leads-bulk-delete')).toHaveTextContent('Delete 1')
  })

  it('surfaces a server error instead of claiming success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    fireEvent.click(screen.getByTestId('leads-bulk-archive'))
    fireEvent.click(screen.getByTestId('leads-bulk-archive-confirm'))
    await waitFor(() => expect(screen.getByTestId('leads-error')).toHaveTextContent('nope'))
    expect(screen.queryByTestId('leads-note')).not.toBeInTheDocument()
  })
})

// ── §24.201: triage without the agent ────────────────────────────────────────

type Handler = (body: Record<string, unknown>) => { status: number; body: unknown }

/** A fetch stub that serves a lead's tailored runs and routes admin-leads POSTs
 *  by action. Returns the mock so tests can read what was sent. */
function stubApi(handlers: Record<string, Handler> = {}, runs: unknown[] = []) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/tailored')) return new Response(JSON.stringify({ runs }), { status: 200 })
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const h = handlers[String(body.action)]
    const out = h ? h(body) : { status: 200, body: { ok: true } }
    return new Response(JSON.stringify(out.body), { status: out.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function postedBodies(fetchMock: ReturnType<typeof stubApi>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/admin/leads') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

const MIXED: AdminLeadsView = {
  ...DATA,
  leads: [
    lead({ id: 'agg', company: 'Repostly', rules_score: 90, source: 'google_jobs', apply_link_kind: 'aggregator' }),
    lead({ id: 'co', company: 'Acme', rules_score: 80, source: 'google_jobs', apply_link_kind: 'company' }),
    lead({ id: 'board', company: 'Globex', rules_score: 70, source: 'greenhouse', apply_link_kind: null }),
    lead({ id: 'nolink', company: 'Initech', rules_score: 60, source: 'google_jobs', apply_link_kind: null }),
    lead({ id: 'man', company: 'Hooli', rules_score: 50, source: 'manual', apply_link_kind: null }),
  ],
}

describe('linkKindOf (§24.201 D1)', () => {
  it('uses apply_link_kind, else falls back on source', () => {
    expect(linkKindOf({ apply_link_kind: 'aggregator', source: 'google_jobs' })).toBe('aggregator')
    expect(linkKindOf({ apply_link_kind: 'company', source: 'google_jobs' })).toBe('company')
    expect(linkKindOf({ apply_link_kind: null, source: 'manual' })).toBe('manual')
    expect(linkKindOf({ apply_link_kind: null, source: 'greenhouse' })).toBe('ats')
    expect(linkKindOf({ apply_link_kind: null, source: 'lever' })).toBe('ats')
    expect(linkKindOf({ apply_link_kind: null, source: 'ashby' })).toBe('ats')
    expect(linkKindOf({ apply_link_kind: null, source: 'google_jobs' })).toBe('unknown')
  })
})

describe('LeadsPanel — link kind (§24.201 D1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('every row carries a link chip derived from apply_link_kind with the source fallback', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    const chips = screen.getAllByTestId('leads-link-chip')
    expect(chips.map((c) => c.getAttribute('data-kind'))).toEqual(['aggregator', 'company', 'ats', 'unknown', 'manual'])
    expect(chips[2]).toHaveTextContent('direct ATS')
  })

  it('the Link filter narrows to one kind and the bulk count follows', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.change(screen.getByTestId('leads-filter-link'), { target: { value: 'aggregator' } })
    expect(screen.getAllByTestId('leads-row')).toHaveLength(1)
    expect(screen.getByText('Repostly')).toBeInTheDocument()
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('1')

    fireEvent.change(screen.getByTestId('leads-filter-link'), { target: { value: 'ats' } })
    expect(screen.getAllByTestId('leads-row')).toHaveLength(1)
    expect(screen.getByText('Globex')).toBeInTheDocument() // NULL kind on a board source
  })
})

describe('LeadsPanel — freshness (§24.201 D5)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    try {
      window.localStorage.clear()
    } catch {
      // ignore
    }
  })

  const FRESH: AdminLeadsView = {
    ...DATA,
    leads: [
      lead({
        id: 'old',
        company: 'Oldco',
        rules_score: 90,
        first_seen_at: '2026-06-01T00:00:00Z',
        source_posted_at: '2026-05-01T00:00:00Z',
      }),
      lead({
        id: 'new',
        company: 'Newco',
        rules_score: 10,
        first_seen_at: '2026-06-20T00:00:00Z',
        source_posted_at: '2026-06-19T00:00:00Z',
      }),
    ],
  }

  it('the Posted column sorts by source_posted_at', () => {
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    const names = () => screen.getAllByTestId('leads-row').map((r) => within(r).getByText(/co$/).textContent)
    expect(names()).toEqual(['Oldco', 'Newco']) // by score
    fireEvent.click(screen.getByTestId('datatable-sort-posted')) // newest posting first
    expect(names()).toEqual(['Newco', 'Oldco'])
  })

  it('marks leads first seen since the previous visit, then stamps this visit', () => {
    window.localStorage.setItem('career-pilot.admin.leads.last-visit', String(Date.parse('2026-06-10T00:00:00Z')))
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    const rows = screen.getAllByTestId('leads-row')
    expect(within(rows[0]).queryByTestId('leads-new-marker')).not.toBeInTheDocument() // Oldco
    expect(within(rows[1]).getByTestId('leads-new-marker')).toBeInTheDocument() // Newco
    expect(Number(window.localStorage.getItem('career-pilot.admin.leads.last-visit'))).toBeGreaterThan(
      Date.parse('2026-06-10T00:00:00Z'),
    )
  })

  it('a first visit marks nothing', () => {
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.queryAllByTestId('leads-new-marker')).toHaveLength(0)
  })

  // A tab switch unmounts the panel and mounts it again — that is the same
  // visit, so the markers stay and the stored last visit is not advanced twice.
  it('a remount in the same browser session keeps the markers (a tab switch is not a new visit)', () => {
    const before = Date.parse('2026-06-10T00:00:00Z')
    window.localStorage.setItem('career-pilot.admin.leads.last-visit', String(before))
    const first = render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-new-marker')).toHaveLength(1)
    const stamped = window.localStorage.getItem('career-pilot.admin.leads.last-visit')
    expect(Number(stamped)).toBeGreaterThan(before)
    first.unmount()

    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-new-marker')).toHaveLength(1)
    expect(window.localStorage.getItem('career-pilot.admin.leads.last-visit')).toBe(stamped)
  })

  it('a new browser session reads the advanced last visit', () => {
    window.localStorage.setItem('career-pilot.admin.leads.last-visit', String(Date.parse('2026-06-10T00:00:00Z')))
    const first = render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-new-marker')).toHaveLength(1)
    first.unmount()
    // a new session: the previous one stamped "now", which is after Newco
    resetLeadsVisitSessionForTests()
    window.sessionStorage.clear()
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.queryAllByTestId('leads-new-marker')).toHaveLength(0)
  })

  it('still renders, and keeps the markers across a remount, when sessionStorage throws', () => {
    window.localStorage.setItem('career-pilot.admin.leads.last-visit', String(Date.parse('2026-06-10T00:00:00Z')))
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const first = render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-row')).toHaveLength(2)
    expect(screen.getAllByTestId('leads-new-marker')).toHaveLength(1)
    first.unmount()
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-new-marker')).toHaveLength(1)
  })

  it('still renders when both storages throw', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-row')).toHaveLength(2)
    expect(screen.queryAllByTestId('leads-new-marker')).toHaveLength(0)
  })

  it('still renders when localStorage throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    render(<LeadsPanel data={FRESH} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getAllByTestId('leads-row')).toHaveLength(2)
    expect(screen.queryAllByTestId('leads-new-marker')).toHaveLength(0)
  })
})

describe('LeadsPanel — selection drives the batch (§24.201 D2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('ticking rows switches the batch to the selection; the count equals the ids sent', async () => {
    const fetchMock = stubApi()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('5')

    const rows = screen.getAllByTestId('leads-row')
    fireEvent.click(within(rows[0]).getByTestId('datatable-select-row'))
    fireEvent.click(within(rows[3]).getByTestId('datatable-select-row'))
    expect(screen.queryByTestId('leads-detail')).not.toBeInTheDocument() // ticking never expands
    expect(screen.getByTestId('leads-bulk-bar')).toHaveAttribute('data-mode', 'selected')
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('2')
    expect(screen.getByTestId('leads-bulk-archive')).toHaveTextContent('Archive 2')

    fireEvent.click(screen.getByTestId('leads-bulk-archive'))
    fireEvent.click(screen.getByTestId('leads-bulk-archive-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toMatchObject({ action: 'bulk_set_status', ids: ['agg', 'nolink'] })
    // the selection is spent
    await waitFor(() => expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('5'))
  })

  it('with nothing ticked the batch still acts on every shown row', async () => {
    const fetchMock = stubApi()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-bulk-delete'))
    fireEvent.click(screen.getByTestId('leads-bulk-delete-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect((postedBodies(fetchMock)[0].ids as string[]).length).toBe(5)
  })

  it('a selection change disarms a pending confirm', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    const rows = screen.getAllByTestId('leads-row')
    fireEvent.click(within(rows[0]).getByTestId('datatable-select-row'))
    fireEvent.click(screen.getByTestId('leads-bulk-delete'))
    expect(screen.getByTestId('leads-bulk-delete-confirm')).toHaveTextContent('Confirm delete 1?')
    fireEvent.click(within(rows[1]).getByTestId('datatable-select-row'))
    expect(screen.queryByTestId('leads-bulk-delete-confirm')).not.toBeInTheDocument()
    expect(screen.getByTestId('leads-bulk-delete')).toHaveTextContent('Delete 2')
  })

  it('a filter that hides a ticked row drops it from the selection (never act on unseen rows)', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    const rows = screen.getAllByTestId('leads-row')
    fireEvent.click(within(rows[0]).getByTestId('datatable-select-row')) // Repostly (aggregator)
    fireEvent.click(within(rows[1]).getByTestId('datatable-select-row')) // Acme (company)
    fireEvent.change(screen.getByTestId('leads-filter-link'), { target: { value: 'company' } })
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('1')
    // widening the filter again does not resurrect the hidden tick
    fireEvent.change(screen.getByTestId('leads-filter-link'), { target: { value: 'all' } })
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('1')
    expect(screen.getByTestId('leads-bulk-bar')).toHaveAttribute('data-mode', 'selected')
  })

  it('clear selection returns to "all shown"', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('datatable-select-page'))
    expect(screen.getByTestId('leads-bulk-count')).toHaveTextContent('5')
    expect(screen.getByTestId('leads-bulk-bar')).toHaveAttribute('data-mode', 'selected')
    fireEvent.click(screen.getByTestId('leads-bulk-clear'))
    expect(screen.getByTestId('leads-bulk-bar')).toHaveAttribute('data-mode', 'shown')
  })

  it("surfaces bulk_delete's skip report in the result note", async () => {
    stubApi({
      bulk_delete: () => ({
        status: 200,
        body: { ok: true, deleted: 2, skipped: 3, skipped_by_reason: { promoted: 1, email_linked: 2 } },
      }),
    })
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-bulk-delete'))
    fireEvent.click(screen.getByTestId('leads-bulk-delete-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('leads-note')).toHaveTextContent(
        'Deleted 2 leads. Skipped 3: 1 promoted to an application, 2 linked to an email.',
      ),
    )
  })
})

describe('bulkDeleteNote', () => {
  it('falls back to "up to N" when the host sends no counts', () => {
    expect(bulkDeleteNote(4, {})).toBe('Deleted up to 4 leads (promoted leads skipped).')
    expect(bulkDeleteNote(1, undefined)).toBe('Deleted up to 1 lead (promoted leads skipped).')
  })
  // The host skips only promoted and email-linked leads — a tailored résumé is
  // deleted with its lead, so the note never claims a résumé-based skip.
  it('names only the host’s skip reasons and omits a zero skip', () => {
    expect(bulkDeleteNote(3, { deleted: 2, skipped: 1, skipped_by_reason: { email_linked: 1 } })).toBe(
      'Deleted 2 leads. Skipped 1: 1 linked to an email.',
    )
    expect(bulkDeleteNote(3, { deleted: 3, skipped: 0 })).toBe('Deleted 3 leads.')
    // a stray key the host never sends is not rendered as a skip reason
    const stray = { deleted: 2, skipped: 1, skipped_by_reason: { tailored_resume: 1 } } as unknown as Parameters<
      typeof bulkDeleteNote
    >[1]
    expect(bulkDeleteNote(3, stray)).not.toMatch(/résumé/)
  })
})

describe('LeadsPanel — bulk delete warning', () => {
  it('the armed delete says a tailored résumé is deleted with its lead (the host does not skip it)', () => {
    render(<LeadsPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-bulk-delete'))
    const warning = screen.getByTestId('leads-bulk-delete-warning')
    expect(warning).toHaveTextContent('promoted and email-linked leads are skipped')
    expect(warning).toHaveTextContent('a tailored résumé is deleted with its lead')
    expect(warning).not.toHaveTextContent('or a tailored résumé')
  })
})

describe('LeadsPanel — keyboard triage (§24.201 D3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const focused = () => screen.getAllByTestId('leads-row').findIndex((r) => r.getAttribute('data-focused') === 'true')

  it('j / k move the focus through the rows in display order', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(focused()).toBe(-1)
    fireEvent.keyDown(window, { key: 'j' })
    expect(focused()).toBe(0)
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'j' })
    expect(focused()).toBe(2)
    fireEvent.keyDown(window, { key: 'k' })
    expect(focused()).toBe(1)
  })

  it('a archives and q queues the focused lead', async () => {
    const fetchMock = stubApi()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'a' })
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toEqual({ action: 'set_status', id: 'agg', status: 'archived' })
    await waitFor(() => expect(screen.getByTestId('leads-rescore-all')).not.toBeDisabled())
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'q' })
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(2))
    expect(postedBodies(fetchMock)[1]).toEqual({ action: 'set_status', id: 'co', status: 'queued' })
  })

  it('a / q never move a lead already promoted to an application', () => {
    const fetchMock = stubApi()
    const data: AdminLeadsView = {
      ...DATA,
      leads: [lead({ id: 'p', company: 'Acme', rules_score: 5, status: 'applied', application_id: 'app-1' })],
    }
    render(<LeadsPanel data={data} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'q' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(postedBodies(fetchMock)).toHaveLength(0)
    expect(screen.getByTestId('leads-note')).toHaveTextContent('already an application')
  })

  it('o opens the focused lead’s apply link', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const data: AdminLeadsView = {
      ...DATA,
      leads: [lead({ id: 'l1', company: 'Acme', rules_score: 5, apply_url: 'https://apply.example.com/1' })],
    }
    render(<LeadsPanel data={data} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'o' }) // nothing focused → nothing opens
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'o' })
    expect(open).toHaveBeenCalledWith('https://apply.example.com/1', '_blank', 'noopener,noreferrer')
  })

  it('x expands the focused lead with its "not interested" form open', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'x' })
    expect(screen.getByTestId('leads-detail')).toBeInTheDocument()
    expect(screen.getByTestId('leads-ni-form')).toBeInTheDocument()
  })

  it('is inert while a text field or select has focus', () => {
    const fetchMock = stubApi()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    const search = screen.getByTestId('leads-search')
    search.focus()
    fireEvent.keyDown(search, { key: 'j' })
    expect(focused()).toBe(-1)
    const select = screen.getByTestId('leads-filter-status')
    select.focus()
    fireEvent.keyDown(select, { key: 'j' })
    expect(focused()).toBe(-1)
    // a row checkbox does NOT swallow triage keys (it takes no text)
    const box = within(screen.getAllByTestId('leads-row')[0]).getByTestId('datatable-select-row')
    box.focus()
    fireEvent.keyDown(box, { key: 'j' })
    expect(focused()).toBe(0)
    expect(postedBodies(fetchMock)).toHaveLength(0)
  })

  // §24.201 D3: after ticking a row, the outlined row may be a different one —
  // a / q / x / o must not act on it from the checkbox; j / k still move.
  it('acting keys are inert while a row checkbox has focus; j still moves', () => {
    const fetchMock = stubApi()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'j' }) // outline row 0
    expect(focused()).toBe(0)
    const box = within(screen.getAllByTestId('leads-row')[2]).getByTestId('datatable-select-row')
    fireEvent.click(box)
    box.focus()
    for (const key of ['a', 'q', 'x', 'o']) fireEvent.keyDown(box, { key })
    expect(postedBodies(fetchMock)).toHaveLength(0)
    expect(screen.queryByTestId('leads-ni-form')).not.toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'j' })
    expect(focused()).toBe(1)
  })

  it('clicking a row moves the keyboard focus there', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[3])
    expect(focused()).toBe(3)
    fireEvent.keyDown(window, { key: 'j' })
    expect(focused()).toBe(4)
  })
})

describe('LeadsPanel — not interested (§24.201 D4)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('is two-step and posts the reason + exclude_title, then reports the tombstone reach', async () => {
    const fetchMock = stubApi({
      not_interested: (b) => ({
        status: 200,
        body: { ok: true, id: b.id, tombstone_match: 'id', title_blocklisted: true },
      }),
    })
    const onSaved = vi.fn()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={onSaved} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[1]) // Acme
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    expect(postedBodies(fetchMock)).toHaveLength(0) // opening sends nothing
    fireEvent.change(screen.getByTestId('leads-ni-reason'), { target: { value: 'location' } })
    fireEvent.click(screen.getByTestId('leads-ni-exclude-title'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toEqual({
      action: 'not_interested',
      id: 'co',
      reason: 'location',
      exclude_title: true,
    })
    await waitFor(() => expect(screen.getByTestId('leads-note')).toHaveTextContent('this posting will not come back'))
    expect(screen.getByTestId('leads-note')).toHaveTextContent('is now excluded')
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByTestId('leads-ni-form')).not.toBeInTheDocument()
  })

  it('a fingerprint tombstone says near-identical re-posts stay out too', async () => {
    stubApi({
      not_interested: (b) => ({
        status: 200,
        body: { ok: true, id: b.id, tombstone_match: 'fingerprint', title_blocklisted: false },
      }),
    })
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() => expect(screen.getByTestId('leads-note')).toHaveTextContent('near-identical re-posts'))
  })

  it('a server "promoted" refusal is a plain message plus a refresh', async () => {
    stubApi({ not_interested: () => ({ status: 409, body: { error: 'promoted', application_id: 'app-1' } }) })
    const onSaved = vi.fn()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={onSaved} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[1])
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('leads-error')).toHaveTextContent(
        'already an application — change it on the Pipeline tab',
      ),
    )
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByTestId('leads-ni-form')).not.toBeInTheDocument()
  })

  it('the controls have accessible names', () => {
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Select all rows on this page' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /^Select Acme — / })).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('leads-row')[1])
    expect(screen.getByRole('combobox', { name: 'status' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    expect(screen.getByRole('combobox', { name: 'reason' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /exclude this title/ })).toBeInTheDocument()
  })

  it('is not offered on a lead already promoted to an application', () => {
    const data: AdminLeadsView = {
      ...DATA,
      leads: [lead({ id: 'p', company: 'Acme', rules_score: 5, application_id: 'app-1' })],
    }
    render(<LeadsPanel data={data} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    expect(screen.queryByTestId('leads-ni-open')).not.toBeInTheDocument()
  })
})

describe('LeadsPanel — "I applied" (§24.201 D8)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const ONE: AdminLeadsView = {
    ...DATA,
    leads: [lead({ id: 'l1', company: 'Acme', rules_score: 70, title: 'Staff Engineer' })],
  }
  const READY_RUN = {
    id: 'run-ready',
    lead_id: 'l1',
    created_at: '2026-06-24T00:00:00Z',
    completed_at: '2026-06-24T00:01:00Z',
    status: 'ready',
    jd_used: null,
    notes: null,
    bio_outcome: 'tailored',
    model: null,
    cost_cents: 3,
    error: null,
    source_slug: null,
    has_resume: true,
  }
  const FAILED_RUN = { ...READY_RUN, id: 'run-failed', status: 'failed', has_resume: false }

  function okApplied(over: Record<string, unknown> = {}): Handler {
    return () => ({
      status: 200,
      body: {
        ok: true,
        application_id: 'app-9',
        obfuscated_label: 'Fintech Co. A',
        lead_id: 'l1',
        prior_status: 'new',
        undo_until: new Date(Date.now() + 90_000).toISOString(),
        ...over,
      },
    })
  }

  it('the note input has an accessible name', () => {
    stubApi()
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    expect(screen.getByRole('textbox', { name: /application note/i })).toBe(screen.getByTestId('leads-applied-note'))
  })

  it('is hidden when the lead already has an application', () => {
    const data: AdminLeadsView = {
      ...DATA,
      leads: [lead({ id: 'p', company: 'Acme', rules_score: 5, application_id: 'a' })],
    }
    render(<LeadsPanel data={data} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    expect(screen.getByTestId('leads-detail-actions')).toBeInTheDocument()
    expect(screen.queryByTestId('leads-applied-open')).not.toBeInTheDocument()
  })

  it('records the application with today’s date, the note and the picked ready résumé, then offers Undo', async () => {
    const fetchMock = stubApi({ applied_from_lead: okApplied() }, [READY_RUN, FAILED_RUN])
    const onSaved = vi.fn()
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={onSaved} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    expect(postedBodies(fetchMock)).toHaveLength(0)

    const date = screen.getByTestId('leads-applied-date') as HTMLInputElement
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // only the ready résumé is offered, and it is the default
    const picker = await screen.findByTestId('leads-applied-resume')
    if (!(picker instanceof HTMLSelectElement)) throw new Error('the résumé picker is not a <select>')
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'run-ready'])
    expect(picker.value).toBe('run-ready')

    fireEvent.change(screen.getByTestId('leads-applied-note'), { target: { value: 'referred' } })
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toEqual({
      action: 'applied_from_lead',
      lead_id: 'l1',
      applied_at: date.value,
      note: 'referred',
      tailored_resume_id: 'run-ready',
    })
    expect(await screen.findByTestId('leads-applied-state')).toHaveTextContent('Fintech Co. A')
    expect(screen.getByTestId('leads-applied-undo')).toHaveTextContent(/Undo \(1:[23]\d\)/)
    expect(screen.queryByTestId('leads-applied-open')).not.toBeInTheDocument()
    expect(onSaved).toHaveBeenCalled()
  })

  it('on a 409 duplicate shows the existing application and "Create anyway" resends with confirm_duplicate', async () => {
    const fetchMock = stubApi({
      applied_from_lead: (b) =>
        b.confirm_duplicate
          ? okApplied()(b)
          : {
              status: 409,
              body: {
                error: 'duplicate',
                duplicate_of: { id: 'app-1', company_name: 'Acme', role_title: 'Staff Engineer', status: 'APPLIED' },
              },
            },
    })
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    const dup = await screen.findByTestId('leads-applied-duplicate')
    expect(dup).toHaveTextContent('Acme · Staff Engineer (APPLIED)')
    fireEvent.click(screen.getByTestId('leads-applied-create-anyway'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(2))
    expect(postedBodies(fetchMock)[1]).toMatchObject({ action: 'applied_from_lead', confirm_duplicate: true })
    expect(await screen.findByTestId('leads-applied-state')).toBeInTheDocument()
  })

  it('omits the résumé picker when the lead has no ready résumé', async () => {
    const fetchMock = stubApi({ applied_from_lead: okApplied() }, [FAILED_RUN])
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tailored')).length).toBeGreaterThan(1),
    )
    expect(screen.queryByTestId('leads-applied-resume')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).not.toHaveProperty('tailored_resume_id')
  })

  it('reports an already-linked lead plainly', async () => {
    stubApi({ applied_from_lead: () => ({ status: 409, body: { error: 'already_linked' } }) })
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    await waitFor(() => expect(screen.getByTestId('leads-error')).toHaveTextContent('already linked'))
  })

  async function applyThenUndo(undo: Handler) {
    const fetchMock = stubApi({ applied_from_lead: okApplied(), undo_applied: undo })
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    fireEvent.click(await screen.findByTestId('leads-applied-undo'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(2))
    expect(postedBodies(fetchMock)[1]).toEqual({ action: 'undo_applied', application_id: 'app-9' })
  }

  it('Undo calls undo_applied and restores the "I applied" button', async () => {
    await applyThenUndo(() => ({ status: 200, body: { ok: true, lead_id: 'l1', restored_status: 'new' } }))
    await waitFor(() => expect(screen.getByTestId('leads-note')).toHaveTextContent('back to “new”'))
    expect(screen.queryByTestId('leads-applied-state')).not.toBeInTheDocument()
    expect(screen.getByTestId('leads-applied-open')).toBeInTheDocument()
  })

  it('a passed undo window is a plain message', async () => {
    await applyThenUndo(() => ({ status: 409, body: { error: 'undo_window_passed' } }))
    await waitFor(() => expect(screen.getByTestId('leads-error')).toHaveTextContent('undo window has passed'))
  })

  it('a referenced application refuses undo with the server detail', async () => {
    await applyThenUndo(() => ({ status: 409, body: { error: 'referenced', detail: 'an email event' } }))
    await waitFor(() => expect(screen.getByTestId('leads-error')).toHaveTextContent('(an email event)'))
  })

  it('the Undo stays reachable when the refresh filters the just-applied lead out of view', async () => {
    const fetchMock = stubApi({
      applied_from_lead: okApplied(),
      undo_applied: () => ({ status: 200, body: { ok: true, lead_id: 'l1', restored_status: 'new' } }),
    })
    const after: AdminLeadsView = {
      ...ONE,
      leads: [{ ...ONE.leads[0], status: 'applied', application_id: 'app-9' }],
    }
    let view = ONE
    const onSaved = vi.fn()
    const { rerender } = render(<LeadsPanel data={view} baseUrl="http://x" onSaved={onSaved} />)
    onSaved.mockImplementation(() => {
      view = after
    })
    fireEvent.change(screen.getByTestId('leads-filter-status'), { target: { value: 'new' } })
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // the parent's refresh: the lead is 'applied' now, so Status=new hides it
    rerender(<LeadsPanel data={view} baseUrl="http://x" onSaved={onSaved} />)
    expect(screen.queryAllByTestId('leads-row')).toHaveLength(0)
    const entry = await screen.findByTestId('leads-applied-entry')
    expect(entry).toHaveTextContent('Acme')
    fireEvent.click(within(entry).getByTestId('leads-applied-undo'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(2))
    expect(postedBodies(fetchMock)[1]).toEqual({ action: 'undo_applied', application_id: 'app-9' })
    await waitFor(() => expect(screen.queryByTestId('leads-applied-entry')).not.toBeInTheDocument())
  })

  it('the Undo button is replaced once undo_until has passed', async () => {
    stubApi({ applied_from_lead: okApplied({ undo_until: new Date(Date.now() - 1000).toISOString() }) })
    render(<LeadsPanel data={ONE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-applied-open'))
    fireEvent.click(screen.getByTestId('leads-applied-confirm'))
    expect(await screen.findByTestId('leads-applied-undo-expired')).toBeInTheDocument()
    expect(screen.queryByTestId('leads-applied-undo')).not.toBeInTheDocument()
  })
})

describe('LeadsPanel — title blocklist (§24.201 D4)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const LISTED: AdminLeadsView = { ...MIXED, titleBlocklist: ['Sales Engineer', 'Staff Recruiter'] }

  it('is hidden when the blocklist is empty (or absent)', () => {
    const { unmount } = render(
      <LeadsPanel data={{ ...MIXED, titleBlocklist: [] }} baseUrl="http://x" onSaved={vi.fn()} />,
    )
    expect(screen.queryByTestId('leads-blocklist')).not.toBeInTheDocument()
    unmount()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.queryByTestId('leads-blocklist')).not.toBeInTheDocument()
  })

  it('is collapsed by default, expands to the entries, and remove posts title_blocklist_remove', async () => {
    const fetchMock = stubApi({
      title_blocklist_remove: () => ({
        status: 200,
        body: { ok: true, removed: true, title_blocklist: ['Staff Recruiter'] },
      }),
    })
    const onSaved = vi.fn()
    render(<LeadsPanel data={LISTED} baseUrl="http://x" onSaved={onSaved} />)
    const toggle = screen.getByTestId('leads-blocklist-toggle')
    expect(toggle).toHaveTextContent('2 excluded titles ▸')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByTestId('leads-blocklist-entry')).toHaveLength(0)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('leads-blocklist-entry')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Stop excluding “Staff Recruiter”' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop excluding “Sales Engineer”' }))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toEqual({ action: 'title_blocklist_remove', title: 'Sales Engineer' })
    await waitFor(() => expect(screen.getAllByTestId('leads-blocklist-entry')).toHaveLength(1))
    expect(screen.getByTestId('leads-blocklist-toggle')).toHaveTextContent('1 excluded title ▾')
    expect(screen.getByTestId('leads-note')).toHaveTextContent('“Sales Engineer” is no longer excluded')
    expect(onSaved).toHaveBeenCalled()
  })

  it('a "not interested" that excludes the title shows it in the header list', async () => {
    stubApi({
      not_interested: (b) => ({
        status: 200,
        body: {
          ok: true,
          id: b.id,
          tombstone_match: 'fingerprint',
          title_blocklisted: true,
          title_blocklist: ['Senior Software Engineer'],
        },
      }),
    })
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.queryByTestId('leads-blocklist')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.click(screen.getByTestId('leads-ni-exclude-title'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() => expect(screen.getByTestId('leads-blocklist-toggle')).toHaveTextContent('1 excluded title'))
  })
})

describe('LeadsPanel — promoted leads (§24.201 D4/D8)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('the status select is disabled for a lead that already backs an application', () => {
    const data: AdminLeadsView = {
      ...DATA,
      leads: [
        lead({ id: 'p', company: 'Acme', rules_score: 5, status: 'applied', application_id: 'app-1' }),
        lead({ id: 'n', company: 'Globex', rules_score: 4 }),
      ],
    }
    render(<LeadsPanel data={data} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    expect(screen.getByTestId('leads-status-select')).toBeDisabled()
    fireEvent.click(screen.getAllByTestId('leads-row')[1])
    expect(screen.getByTestId('leads-status-select')).not.toBeDisabled()
  })

  it('a set_status refused as promoted is a plain message plus a refresh', async () => {
    stubApi({ set_status: () => ({ status: 409, body: { error: 'promoted', application_id: 'app-1' } }) })
    const onSaved = vi.fn()
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={onSaved} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.change(screen.getByTestId('leads-status-select'), { target: { value: 'queued' } })
    await waitFor(() =>
      expect(screen.getByTestId('leads-error')).toHaveTextContent(
        'This lead is already an application — change it on the Pipeline tab.',
      ),
    )
    expect(onSaved).toHaveBeenCalled()
  })

  it("surfaces bulk archive's promoted skips in the result note", async () => {
    stubApi({
      bulk_set_status: () => ({
        status: 200,
        body: { ok: true, updated: 3, missing: 0, status: 'archived', skipped: 2, skipped_by_reason: { promoted: 2 } },
      }),
    })
    render(<LeadsPanel data={MIXED} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-bulk-archive'))
    fireEvent.click(screen.getByTestId('leads-bulk-archive-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('leads-note')).toHaveTextContent(
        'Archived 3 leads. Skipped 2: 2 promoted to an application.',
      ),
    )
  })
})

describe('bulkArchiveNote', () => {
  it('reports the server count and its promoted skips; falls back when the host sends none', () => {
    expect(bulkArchiveNote(2, {})).toBe('Archived 2 leads.')
    expect(bulkArchiveNote(1, undefined)).toBe('Archived 1 lead.')
    expect(bulkArchiveNote(4, { updated: 3, skipped: 1, skipped_by_reason: { promoted: 1 } })).toBe(
      'Archived 3 leads. Skipped 1: 1 promoted to an application.',
    )
    expect(bulkArchiveNote(4, { updated: 4, skipped: 0 })).toBe('Archived 4 leads.')
  })
})
