import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminLead, AdminLeadsSourcing, AdminLeadsView, LeadSweepRun } from '~/lib/use-admin'

import {
  LEAD_SOURCES,
  LeadsPanel,
  notInterestedNote,
  quotaLine,
  resetLeadsVisitSessionForTests,
  sweepSummary,
} from './LeadsPanel'

// §24.200 slice (b) / §24.201 D4 + D6 on the Leads tab: the sourcing strip,
// "Sweep now", "block this company's board", and the ashby source.

beforeEach(() => {
  resetLeadsVisitSessionForTests()
  try {
    window.sessionStorage.clear()
  } catch {
    // ignore
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

const HOUR = 3_600_000
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()

function sweepRun(over: Partial<LeadSweepRun> = {}): LeadSweepRun {
  return {
    id: 'run-1',
    started_at: isoAgo(3 * HOUR + 60_000),
    finished_at: isoAgo(3 * HOUR),
    ok: true,
    trigger: 'schedule',
    boards_ok: 12,
    boards_failed: 1,
    new: 4,
    refreshed: 30,
    closed: 2,
    reopened: 1,
    rejected: { filter: 40, age: 3, tombstone: 2, cap: 0 },
    failing_boards: [{ company: 'Acme', ats: 'lever', error: 'HTTP 500' }],
    ...over,
  }
}

function sourcing(over: Partial<AdminLeadsSourcing> = {}): AdminLeadsSourcing {
  return {
    lastSweep: sweepRun(),
    sweepRunning: false,
    lastSearch: {
      at: isoAgo(2 * HOUR),
      rejected: { aggregator: 6 },
      rejected_by_site: { 'reposter.example': 5, 'other.example': 1 },
    },
    searchQuota: { used_period: 120, monthly_quota: 250, used_today: 4, daily_cap: 20, period_start: '2026-11-01' },
    ...over,
  }
}

const BASE: AdminLeadsView = {
  rollup: {
    activeTotal: 3,
    closedTotal: 0,
    byStatus: { new: 3 },
    bySource: { greenhouse: 1, ashby: 1, google_jobs: 1 },
    llmScored: 0,
    pushed24h: 0,
    added24h: 0,
    added7d: 3,
    newestAgeHours: 5,
  },
  leads: [
    lead({ id: 'gh', company: 'Globex', rules_score: 90, source: 'greenhouse' }),
    lead({ id: 'ab', company: 'Umbrella', rules_score: 80, source: 'ashby', apply_link_kind: null }),
    lead({ id: 'gj', company: 'Acme', rules_score: 70, source: 'google_jobs', apply_link_kind: 'company' }),
  ],
  closed: [],
}

const withSourcing = (over: Partial<AdminLeadsSourcing> = {}): AdminLeadsView => ({
  ...BASE,
  sourcing: sourcing(over),
})

type Handler = (body: Record<string, unknown>) => { status: number; body: unknown }

function stubApi(handlers: Record<string, Handler> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/tailored')) return new Response(JSON.stringify({ runs: [] }), { status: 200 })
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

describe('LeadsPanel — sourcing strip (§24.201 D6)', () => {
  it('renders without a sourcing block from an older host — no strip, no Sweep now', () => {
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByTestId('leads-rollup')).toBeInTheDocument()
    expect(screen.getAllByTestId('leads-row')).toHaveLength(3)
    expect(screen.queryByTestId('leads-sourcing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('leads-sweep-now')).not.toBeInTheDocument()
  })

  it('shows the last sweep in one line, the search refusals by site, and the quota', () => {
    render(<LeadsPanel data={withSourcing()} baseUrl="http://x" onSaved={vi.fn()} />)
    const strip = screen.getByTestId('leads-sourcing')
    expect(within(screen.getByTestId('leads-rollup')).getByTestId('leads-sourcing')).toBe(strip)
    const summary = screen.getByTestId('leads-sweep-summary')
    expect(summary).toHaveTextContent('Last sweep 3h ago')
    expect(summary).toHaveTextContent('4 new · 2 closed · 1 reopened · boards 12 ok / 1 failed')
    expect(screen.getByTestId('leads-search-summary')).toHaveTextContent(
      'rejected by site: reposter.example 5 · other.example 1',
    )
    expect(screen.getByTestId('leads-search-quota')).toHaveTextContent('120 / 250 this period · today 4 / 20')
    // the detail is collapsed until asked for
    expect(screen.queryByTestId('leads-sweep-detail')).not.toBeInTheDocument()
  })

  it('expands to the rejected-by-reason counts and the failing boards', () => {
    render(<LeadsPanel data={withSourcing()} baseUrl="http://x" onSaved={vi.fn()} />)
    const toggle = screen.getByTestId('leads-sweep-detail-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // largest first; a zero count is dropped
    const rejected = screen.getByTestId('leads-sweep-rejected')
    expect(rejected).toHaveTextContent('rejected: filter 40 · age 3 · tombstone 2')
    expect(rejected).not.toHaveTextContent('cap')
    expect(screen.getAllByTestId('leads-sweep-failing-board')).toHaveLength(1)
    expect(screen.getByTestId('leads-sweep-failing-board')).toHaveTextContent('Acme (lever) — HTTP 500')
  })

  it('says so when no sweep has run and hides the search line when there was no search', () => {
    render(
      <LeadsPanel data={withSourcing({ lastSweep: null, lastSearch: null })} baseUrl="http://x" onSaved={vi.fn()} />,
    )
    expect(screen.getByTestId('leads-sweep-summary')).toHaveTextContent('No sweep has run yet')
    expect(screen.queryByTestId('leads-sweep-detail-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('leads-search-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('leads-search-quota')).toBeInTheDocument()
  })

  it('sweepSummary marks a manual and a failed run; quotaLine formats the quota', () => {
    expect(sweepSummary(sweepRun({ trigger: 'manual', ok: false }))).toMatch(
      /^Last sweep 3h ago \(manual\) · failed · /,
    )
    // an unfinished run row falls back to when it started
    expect(sweepSummary(sweepRun({ finished_at: null, started_at: isoAgo(30 * 60_000) }))).toMatch(
      /^Last sweep just now · /,
    )
    expect(
      quotaLine({ used_period: 0, monthly_quota: 100, used_today: 0, daily_cap: 10, period_start: '2026-11-01' }),
    ).toBe('0 / 100 this period · today 0 / 10')
  })

  it('Sweep now posts sweep_now, is disabled in flight, says it started, and refreshes', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify({ ok: true, started: true }), { status: 202 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    render(<LeadsPanel data={withSourcing()} baseUrl="http://x" onSaved={onSaved} />)
    fireEvent.click(screen.getByTestId('leads-sweep-now'))
    await waitFor(() => expect(screen.getByTestId('leads-sweep-now')).toBeDisabled())
    fireEvent.click(screen.getByTestId('leads-sweep-now'))
    release()
    await waitFor(() => expect(screen.getByTestId('leads-note')).toHaveTextContent('Sweep started'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://x/api/admin/leads')
    expect(JSON.parse(String(init.body))).toEqual({ action: 'sweep_now' })
    expect(onSaved).toHaveBeenCalled()
    expect(screen.getByTestId('leads-sweep-now')).toBeEnabled()
  })

  it('Sweep now is disabled while a sweep is running', () => {
    const fetchMock = stubApi()
    render(<LeadsPanel data={withSourcing({ sweepRunning: true })} baseUrl="http://x" onSaved={vi.fn()} />)
    const btn = screen.getByTestId('leads-sweep-now')
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent('Sweeping…')
    expect(screen.getByTestId('leads-sweep-running')).toBeInTheDocument()
    fireEvent.click(btn)
    expect(postedBodies(fetchMock)).toHaveLength(0)
  })

  it('a 409 already_running is a plain message', async () => {
    stubApi({ sweep_now: () => ({ status: 409, body: { error: 'already_running' } }) })
    render(<LeadsPanel data={withSourcing()} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-sweep-now'))
    await waitFor(() => expect(screen.getByTestId('leads-error')).toHaveTextContent('A sweep is already running'))
  })

  it('a 409 halted is a plain message', async () => {
    stubApi({ sweep_now: () => ({ status: 409, body: { error: 'halted' } }) })
    render(<LeadsPanel data={withSourcing()} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-sweep-now'))
    await waitFor(() => expect(screen.getByTestId('leads-error')).toHaveTextContent('The system is halted'))
    expect(screen.queryByTestId('leads-note')).not.toBeInTheDocument()
  })
})

describe('LeadsPanel — not interested: block company (§24.201 D4)', () => {
  it('offers the board block only on board-sourced leads', () => {
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[1]) // Umbrella (ashby)
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    expect(screen.getByRole('checkbox', { name: /block this company's board/ })).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('leads-row')[2]) // Acme (search)
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    expect(screen.queryByTestId('leads-ni-block-company')).not.toBeInTheDocument()
  })

  it('sends block_company and reports the board paused', async () => {
    const fetchMock = stubApi({
      not_interested: (b) => ({
        status: 200,
        body: { ok: true, id: b.id, tombstone_match: 'fingerprint', title_blocklisted: false, company_blocked: true },
      }),
    })
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0]) // Globex
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.change(screen.getByTestId('leads-ni-reason'), { target: { value: 'company' } })
    fireEvent.click(screen.getByTestId('leads-ni-block-company'))
    expect(screen.getByTestId('leads-ni-form')).toHaveTextContent("Globex's board stops being swept")
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toEqual({
      action: 'not_interested',
      id: 'gh',
      reason: 'company',
      exclude_title: false,
      block_company: true,
    })
    await waitFor(() => expect(screen.getByTestId('leads-note')).toHaveTextContent("Globex's board paused"))
  })

  it('says when no watchlist board matched the company', async () => {
    stubApi({
      not_interested: (b) => ({
        status: 200,
        body: { ok: true, id: b.id, tombstone_match: 'id', title_blocklisted: false, company_blocked: false },
      }),
    })
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.click(screen.getByTestId('leads-ni-block-company'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('leads-note')).toHaveTextContent('no board on the watchlist for Globex'),
    )
  })

  it('a board lead left unticked sends block_company:false; a search lead sends no field', async () => {
    const fetchMock = stubApi()
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getAllByTestId('leads-row')[0])
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(1))
    expect(postedBodies(fetchMock)[0]).toMatchObject({ id: 'gh', block_company: false })
    fireEvent.click(screen.getAllByTestId('leads-row')[2])
    fireEvent.click(screen.getByTestId('leads-ni-open'))
    fireEvent.click(screen.getByTestId('leads-ni-confirm'))
    await waitFor(() => expect(postedBodies(fetchMock)).toHaveLength(2))
    expect(postedBodies(fetchMock)[1]).toMatchObject({ id: 'gj' })
    expect(postedBodies(fetchMock)[1]).not.toHaveProperty('block_company')
  })

  it('notInterestedNote only mentions the board when the block was asked for', () => {
    const l = { company: 'Globex', title: 'Staff Engineer' }
    expect(notInterestedNote(l, 'role', { tombstone_match: 'id', company_blocked: false }, false)).toBe(
      'Not interested (role): archived Globex — this posting will not come back.',
    )
    expect(
      notInterestedNote(l, 'company', { tombstone_match: 'id', title_blocklisted: true, company_blocked: true }, true),
    ).toBe(
      "Not interested (company): archived Globex — this posting will not come back; the title “Staff Engineer” is now excluded; Globex's board paused.",
    )
  })
})

describe('LeadsPanel — ashby source (§24.200 D6d)', () => {
  it('is one of the enumerated sources', () => {
    expect(LEAD_SOURCES).toContain('ashby')
  })

  it('is offered in the Source filter and filters on it, reading as direct ATS', () => {
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    const select = screen.getByTestId('leads-filter-source')
    expect(within(select).getByRole('option', { name: 'ashby' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'ashby' } })
    const rows = screen.getAllByTestId('leads-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Umbrella')
    expect(within(rows[0]).getByTestId('leads-link-chip')).toHaveTextContent('direct ATS')
  })
})
