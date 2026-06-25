import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
})
