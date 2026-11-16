import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AdminLead, type AdminLeadsView, type AgentActionsMeta, boardPromotionNote } from '~/lib/use-admin'

import { bulkDeleteNote, LeadsPanel, resetLeadsVisitSessionForTests } from './LeadsPanel'

// §24.203 on the Leads tab: the agent-action buttons sit in the lead's "act"
// row after "I applied", Run now sits with the header actions, and a host
// without agent actions shows none of it.

beforeEach(() => {
  resetLeadsVisitSessionForTests()
  try {
    window.sessionStorage.clear()
  } catch {
    // ignore
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('/tailored')
        ? new Response(JSON.stringify({ runs: [] }), { status: 200 })
        : new Response(JSON.stringify({ actions: [], meta: META }), { status: 200 }),
    ),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const META: AgentActionsMeta = {
  pause_state: 'active',
  can_enqueue: true,
  daily_cap: 20,
  used_today: 0,
  note_max_chars: 500,
  ttl_minutes: 60,
  guard_minutes: 15,
  compose_authuser: null,
  run_now: {
    job_scrape: { in_flight_action_id: null, next_scheduled_at: null, guarded: false },
    daily_briefing: { in_flight_action_id: null, next_scheduled_at: null, guarded: false },
  },
  kit_rounds: ['SCREENING', 'TECH_SCREEN', 'SYS_DESIGN', 'FINAL'],
}

function lead(over: Partial<AdminLead> & { id: string; company: string }): AdminLead {
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
    rules_score: 80,
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

const BASE: AdminLeadsView = {
  rollup: {
    activeTotal: 1,
    closedTotal: 0,
    byStatus: { new: 1 },
    bySource: { greenhouse: 1 },
    llmScored: 0,
    pushed24h: 0,
    added24h: 0,
    added7d: 1,
    newestAgeHours: 5,
  },
  leads: [lead({ id: 'l1', company: 'Globex' })],
  closed: [],
}

describe('LeadsPanel — agent actions (§24.203)', () => {
  it('puts the action buttons in the lead’s act row, after I applied', () => {
    render(<LeadsPanel data={{ ...BASE, agentActions: META }} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-row'))
    const act = within(screen.getByTestId('leads-detail-actions'))
    const research = act.getByTestId('agent-action-open-research_company')
    const applied = act.getByTestId('leads-applied-open')
    expect(applied.compareDocumentPosition(research) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(act.getByTestId('agent-action-open-draft_outreach')).toBeInTheDocument()
  })

  it('shows Run now for both series with the header actions, and the recent-actions list', () => {
    render(<LeadsPanel data={{ ...BASE, agentActions: META }} baseUrl="http://x" onSaved={vi.fn()} />)
    const rollup = within(screen.getByTestId('leads-rollup'))
    expect(rollup.getByTestId('agent-run-now-job_scrape')).toBeInTheDocument()
    expect(rollup.getByTestId('agent-run-now-daily_briefing')).toBeInTheDocument()
    expect(rollup.getByTestId('agent-actions-recent')).toBeInTheDocument()
  })

  it('a host without agent actions shows none of it', () => {
    render(<LeadsPanel data={BASE} baseUrl="http://x" onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('leads-row'))
    expect(screen.queryByTestId('agent-action-open-research_company')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-run-now-job_scrape')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-actions-recent')).not.toBeInTheDocument()
  })

  it('marks a row whose lead an agent action holds', () => {
    render(
      <LeadsPanel
        data={{
          ...BASE,
          agentActions: META,
          leads: [lead({ id: 'l1', company: 'Globex', actions: { in_flight: true, latest: {} } })],
        }}
        baseUrl="http://x"
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByTestId('leads-action-inflight')).toBeInTheDocument()
  })
})

describe('boardPromotionNote', () => {
  it('names an added board and a raised tier; says nothing otherwise', () => {
    expect(boardPromotionNote({ action: 'added', ats: 'ashby', token: 'globex', tier: 'B' })).toBe(
      'now watching globex on ashby (tier B)',
    )
    expect(boardPromotionNote({ action: 'tier_raised', ats: 'lever', token: 'acme', tier: 'A' })).toBe(
      'acme board raised to tier A',
    )
    expect(boardPromotionNote({ action: 'unchanged', ats: 'lever', token: 'acme', reason: 'paused' })).toBeNull()
    expect(boardPromotionNote(null)).toBeNull()
    expect(boardPromotionNote(undefined)).toBeNull()
  })
})

describe('bulkDeleteNote — the action_in_flight skip reason', () => {
  it('reports every host skip reason together, in the host’s words', () => {
    expect(
      bulkDeleteNote(6, {
        deleted: 2,
        skipped: 4,
        skipped_by_reason: { promoted: 1, email_linked: 1, action_in_flight: 2 },
      }),
    ).toBe(
      'Deleted 2 leads. Skipped 4: 1 promoted to an application, 1 linked to an email, 2 with an agent action still running.',
    )
  })

  it('names leads skipped because an agent action is still running', () => {
    expect(bulkDeleteNote(3, { deleted: 2, skipped: 1, skipped_by_reason: { action_in_flight: 1 } })).toBe(
      'Deleted 2 leads. Skipped 1: 1 with an agent action still running.',
    )
  })
})
