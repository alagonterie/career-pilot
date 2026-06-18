import { fireEvent, render, screen, within } from '@testing-library/react'
import type * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { AuditEvent } from '~/lib/use-activity-stream'

// Isolate from the router — the trace [ref] is a <Link> into the /pipeline
// drawer (§24.60). The anchor stand-in builds the href from to+search so the
// link target stays assertable.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    className,
    'data-testid': testId,
  }: {
    to?: string
    search?: { app?: string }
    children?: React.ReactNode
    className?: string
    'data-testid'?: string
  }) => (
    <a href={search?.app ? `${to}?app=${search.app}` : to} className={className} data-testid={testId}>
      {children}
    </a>
  ),
}))

import { LogStream, nextStuck } from './LogStream'

function ev(p: Partial<AuditEvent> & { seq: number }): AuditEvent {
  return {
    ts: '2026-06-02T16:42:00Z',
    category: 'pipeline',
    agent_name: null,
    proactive: 0,
    application_ref: null,
    model_used: null,
    tokens: null,
    cost_cents: null,
    cache_hit: null,
    cache_read_pct: null,
    latency_ms: null,
    summary: 'an event',
    ...p,
  }
}

const EVENTS: AuditEvent[] = [
  ev({ seq: 1, category: 'pipeline', proactive: 0, application_ref: 'fintech-a', summary: 'logged a recruiter reply' }),
  ev({
    seq: 2,
    category: 'subagent_progress',
    agent_name: 'research-company',
    proactive: 1,
    model_used: 'opus-4-8',
    tokens: 3400,
    cost_cents: 2,
    cache_hit: 1,
    cache_read_pct: 84,
    latency_ms: 4200,
    summary: 'mapped the org',
  }),
  ev({ seq: 3, category: 'subagent_progress', agent_name: 'tailor-resume', proactive: 1, summary: 'tailored bullets' }),
]

describe('LogStream', () => {
  it('shows a connected-but-empty state when open with no events (§24.36 36.1)', () => {
    render(<LogStream events={[]} status="open" count={0} />)
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/no agent activity/i)
  })

  it('shows a connecting affordance before the stream opens (§24.36 36.1)', () => {
    render(<LogStream events={[]} status="idle" count={0} />)
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/connecting/i)
  })

  it('renders one line per event with the progressive metric lanes', () => {
    render(<LogStream events={EVENTS} status="open" count={3} />)
    expect(screen.getAllByTestId('trace-line')).toHaveLength(3)
    // row 2 carries every captured lane
    expect(screen.getByText('opus-4-8')).toBeInTheDocument()
    expect(screen.getByText('3,400 tok')).toBeInTheDocument()
    expect(screen.getByText('4.2s')).toBeInTheDocument()
    expect(screen.getByText('$0.020')).toBeInTheDocument()
    expect(screen.getByText('cache 84%')).toBeInTheDocument()
  })

  it('omits absent lanes — never faked (progressive rendering)', () => {
    render(<LogStream events={[EVENTS[0]]} status="open" count={1} />)
    expect(screen.getByText('[fintech-a]')).toBeInTheDocument()
    expect(screen.queryByText(/cache \d+%/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('trace-proactive')).not.toBeInTheDocument()
    // category is the fallback source label when agent_name is null; the audit
    // data is natively 'pipeline' (§24.77 / migration 137 — no display alias)
    expect(screen.getByText('pipeline')).toBeInTheDocument()
  })

  it('filters to proactive events on the Proactive chip', () => {
    render(<LogStream events={EVENTS} status="open" count={3} />)
    fireEvent.click(screen.getByTestId('trace-chip-proactive'))
    expect(screen.getAllByTestId('trace-line')).toHaveLength(2) // seq 2 + 3
  })

  it('matches a subagent chip on the native agent_name (§24.77 — legacy alias retired)', () => {
    // Post-migration the audit data carries the real names; the single Scribe
    // chip matches 'pipeline-scribe' rows directly (no 'funnel-curator' fan-out).
    const events = [
      ev({ seq: 1, category: 'subagent_progress', agent_name: 'pipeline-scribe', summary: 'classified 2 messages' }),
      ev({ seq: 2, category: 'subagent_progress', agent_name: 'pipeline-scribe', summary: 'persisted state' }),
      ev({ seq: 3, category: 'subagent_progress', agent_name: 'scrape-jobs', summary: 'scanned boards' }),
    ]
    render(<LogStream events={events} status="open" count={3} />)
    expect(screen.getAllByText('pipeline-scribe')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('trace-chip-pipeline-scribe'))
    expect(screen.getAllByTestId('trace-line')).toHaveLength(2)
  })

  it('filters by subagent on a per-agent chip', () => {
    render(<LogStream events={EVENTS} status="open" count={3} />)
    fireEvent.click(screen.getByTestId('trace-chip-research-company'))
    const lines = screen.getAllByTestId('trace-line')
    expect(lines).toHaveLength(1)
    expect(within(lines[0]).getByText('research-company')).toBeInTheDocument()
  })

  it('filters to non-subagent events on the System chip', () => {
    render(<LogStream events={EVENTS} status="open" count={3} />)
    fireEvent.click(screen.getByTestId('trace-chip-system'))
    expect(screen.getAllByTestId('trace-line')).toHaveLength(1) // seq 1 (agent_name null)
  })

  it('shows a no-match message when a filter excludes everything', () => {
    render(<LogStream events={[EVENTS[0]]} status="open" count={1} />)
    fireEvent.click(screen.getByTestId('trace-chip-proactive'))
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/no events match/i)
  })

  it('collapses bare/consecutive turn seals — a turn renders only when it seals ≥1 action (§24.35 Pass C)', () => {
    const turn = (seq: number) => ev({ seq, category: 'turn', summary: 'turn complete', model_used: 'haiku-4-5' })
    render(
      <LogStream
        status="open"
        count={6}
        events={[
          EVENTS[0], // action → sealed by the turn below
          turn(10), // seals the action above → kept
          turn(11), // bare → dropped
          turn(12), // bare → dropped
          EVENTS[1], // action
          turn(13), // seals → kept
        ]}
      />,
    )
    expect(screen.getAllByTestId('trace-line')).toHaveLength(2) // the two actions
    expect(screen.getAllByTestId('trace-turn')).toHaveLength(2) // only the two sealing turns
  })

  it('a window of only turns collapses to the quiet state — no stacked empty rules', () => {
    const turn = (seq: number) => ev({ seq, category: 'turn', summary: 'turn complete' })
    render(<LogStream events={[turn(1), turn(2), turn(3)]} status="open" count={3} />)
    expect(screen.queryByTestId('trace-turn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('trace-line')).not.toBeInTheDocument()
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/no agent activity/i)
  })

  it('opens a stale window with a leading day divider (§24.57 — the fixture days are in the past)', () => {
    render(<LogStream events={EVENTS} status="open" count={3} />)
    const dividers = screen.getAllByTestId('trace-date')
    expect(dividers).toHaveLength(1) // all three events share 2026-06-02
    expect(dividers[0]).toHaveTextContent('Jun 2')
  })

  it('marks a day boundary between events from different days (§24.57)', () => {
    const events = [
      ev({ seq: 1, ts: '2026-06-02T16:42:00Z', summary: 'day one' }),
      ev({ seq: 2, ts: '2026-06-03T09:05:00Z', summary: 'day two' }),
    ]
    render(<LogStream events={events} status="open" count={2} />)
    const dividers = screen.getAllByTestId('trace-date')
    expect(dividers).toHaveLength(2) // leading Jun 2 + the Jun 3 boundary
    expect(dividers[1]).toHaveTextContent('Jun 3')
  })

  it('shows no divider when every event is from today (§24.57)', () => {
    const events = [ev({ seq: 1, ts: new Date().toISOString(), summary: 'fresh' })]
    render(<LogStream events={events} status="open" count={1} />)
    expect(screen.queryByTestId('trace-date')).not.toBeInTheDocument()
  })

  it('renders [ref] as a deep-link into that application’s /pipeline drawer (§24.60)', () => {
    render(<LogStream events={[EVENTS[0]]} status="open" count={1} />)
    const link = screen.getByTestId('trace-ref-link')
    expect(link).toHaveAttribute('href', '/pipeline?app=fintech-a')
    expect(link).toHaveTextContent('[fintech-a]')
  })

  it('carries the single "cast" InfoTip on the header — the six agents, one tip (§24.60)', () => {
    render(<LogStream events={[]} status="open" count={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'About: who the agents are' }))
    const panel = screen.getByTestId('info-tip-panel')
    for (const name of [
      'research-company',
      'tailor-resume',
      'draft-outreach',
      'build-interview-kit',
      'scrape-jobs',
      'pipeline-scribe',
    ]) {
      expect(within(panel).getByText(name)).toBeInTheDocument()
    }
    expect(panel).toHaveTextContent(/orchestrator/i)
  })

  it('filters to one application via appFilter, AND-composed with the chips (§24.60)', () => {
    const events = [
      ev({ seq: 1, application_ref: 'fintech-a', summary: 'reply logged' }),
      ev({ seq: 2, application_ref: 'devtools-b', summary: 'other app' }),
      ev({ seq: 3, application_ref: 'fintech-a', proactive: 1, summary: 'follow-up drafted' }),
    ]
    render(<LogStream events={events} status="open" count={3} appFilter="fintech-a" />)
    expect(screen.getAllByTestId('trace-line')).toHaveLength(2) // seq 1 + 3
    expect(screen.queryByText('other app')).not.toBeInTheDocument()
    // AND-composes: the Proactive chip narrows within the app filter
    fireEvent.click(screen.getByTestId('trace-chip-proactive'))
    expect(screen.getAllByTestId('trace-line')).toHaveLength(1)
    expect(screen.getByText('follow-up drafted')).toBeInTheDocument()
  })

  it('renders the dismissible app-filter chip and clears via its handler (§24.60)', () => {
    const onClear = vi.fn()
    render(<LogStream events={[EVENTS[0]]} status="open" count={1} appFilter="fintech-a" onClearAppFilter={onClear} />)
    const chip = screen.getByTestId('trace-app-filter')
    expect(chip).toHaveTextContent('[fintech-a] ×')
    fireEvent.click(chip)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('shows the live-window honesty copy when the app filter matches nothing (§24.60)', () => {
    render(<LogStream events={[EVENTS[0]]} status="open" count={1} appFilter="ghost-app" />)
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/live window/i)
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/not the full history/i)
  })

  it('renders a category=turn row as a batch-sealing separator, not an action line (§24.35 Pass C)', () => {
    const turn = ev({
      seq: 9,
      category: 'turn',
      summary: 'turn complete',
      model_used: 'opus-4-8',
      tokens: 18400,
      cost_cents: 6,
      cache_hit: 1,
      cache_read_pct: 90,
      latency_ms: 2100,
    })
    render(<LogStream events={[EVENTS[0], turn]} status="open" count={2} />)
    const seal = screen.getByTestId('trace-turn')
    expect(seal).toHaveTextContent('opus-4-8')
    expect(seal).toHaveTextContent('18,400 tok')
    expect(seal).toHaveTextContent('cache 90%')
    // §24.57: the seal explains itself via an InfoTip (mobile-capable), not a title attr
    expect(within(seal).getByTestId('info-tip-trigger')).toBeInTheDocument()
    // the turn row is the seal — NOT one of the action lines
    expect(screen.getAllByTestId('trace-line')).toHaveLength(1)
  })

  it('renders a deterministic dispatch row as a system lifecycle marker, not agent narration (§24.116)', () => {
    const dispatch = ev({
      seq: 5,
      category: 'subagent_progress',
      agent_name: 'scrape-jobs',
      summary: 'Dispatched by the orchestrator.',
    })
    render(<LogStream events={[dispatch]} status="open" count={1} />)
    // the row is still the subagent's (its chip shows) — but rendered as a dim
    // "dispatched" pill, NOT the sentence, so it never reads as the agent speaking
    expect(screen.getByText('scrape-jobs')).toBeInTheDocument()
    expect(screen.getByTestId('trace-dispatch-marker')).toBeInTheDocument()
    expect(screen.queryByText('Dispatched by the orchestrator.')).not.toBeInTheDocument()
    // the pill itself is the quiet disclosure (no ⓘ) — hover/tap reveals a one-liner
    fireEvent.click(screen.getByTestId('trace-dispatch-marker'))
    expect(screen.getByTestId('dispatch-tip-panel')).toHaveTextContent(/orchestrator launched this subagent/i)
  })
})

describe('nextStuck — the auto-follow unstick guard (B4 / §24.62 Δ)', () => {
  const atBottom = { scrollHeight: 1000, scrollTop: 980, clientHeight: 20 } // distance 0
  const scrolledUp = { scrollHeight: 1000, scrollTop: 500, clientHeight: 20 } // distance 480

  it('keeps the current pin for the follow’s own echo scroll (inside the settle window)', () => {
    // A backlog chunk grew the list, so this stale event reads "scrolled up" just
    // after an auto-follow — it must NOT unstick the pin (the B4 bug).
    expect(nextStuck({ prevStuck: true, msSinceAutoFollow: 10, ...scrolledUp })).toBe(true)
  })

  it('honors a genuine user scroll-up outside the settle window', () => {
    expect(nextStuck({ prevStuck: true, msSinceAutoFollow: 500, ...scrolledUp })).toBe(false)
  })

  it('re-sticks when the user scrolls back to the bottom (outside the window)', () => {
    expect(nextStuck({ prevStuck: false, msSinceAutoFollow: 500, ...atBottom })).toBe(true)
  })

  it('still pins at the bottom even inside the window (echo at bottom is a no-op)', () => {
    expect(nextStuck({ prevStuck: true, msSinceAutoFollow: 10, ...atBottom })).toBe(true)
  })
})
