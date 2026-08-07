import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdminLead, AdminLeadsView } from '~/lib/use-admin'

import { LeadsPanel } from './LeadsPanel'

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
    expect(screen.getByTestId('leads-bulk-bar')).toHaveTextContent('promoted leads are skipped')

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
