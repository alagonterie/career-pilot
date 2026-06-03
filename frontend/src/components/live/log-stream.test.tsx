import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AuditEvent } from '~/lib/use-activity-stream'

import { LogStream } from './LogStream'

function ev(p: Partial<AuditEvent> & { seq: number }): AuditEvent {
  return {
    ts: '2026-06-02T16:42:00Z',
    category: 'funnel',
    agent_name: null,
    proactive: 0,
    application_ref: null,
    model_used: null,
    tokens: null,
    cost_cents: null,
    cache_hit: null,
    latency_ms: null,
    summary: 'an event',
    ...p,
  }
}

const EVENTS: AuditEvent[] = [
  ev({ seq: 1, category: 'funnel', proactive: 0, application_ref: 'fintech-a', summary: 'logged a recruiter reply' }),
  ev({
    seq: 2,
    category: 'subagent_progress',
    agent_name: 'research-company',
    proactive: 1,
    model_used: 'opus-4-8',
    tokens: 3400,
    cost_cents: 2,
    cache_hit: 1,
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
    expect(screen.getByText('cache✓')).toBeInTheDocument()
  })

  it('omits absent lanes — never faked (progressive rendering)', () => {
    render(<LogStream events={[EVENTS[0]]} status="open" count={1} />)
    expect(screen.getByText('[fintech-a]')).toBeInTheDocument()
    expect(screen.queryByText('cache✓')).not.toBeInTheDocument()
    expect(screen.queryByTestId('trace-proactive')).not.toBeInTheDocument()
    // category is the fallback label when agent_name is null
    expect(screen.getByText('funnel')).toBeInTheDocument()
  })

  it('filters to proactive events on the Proactive chip', () => {
    render(<LogStream events={EVENTS} status="open" count={3} />)
    fireEvent.click(screen.getByTestId('trace-chip-proactive'))
    expect(screen.getAllByTestId('trace-line')).toHaveLength(2) // seq 2 + 3
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

  it('renders a category=turn row as a batch-sealing separator, not an action line (§24.35 Pass C)', () => {
    const turn = ev({
      seq: 9,
      category: 'turn',
      summary: 'turn complete',
      model_used: 'opus-4-8',
      tokens: 18400,
      cost_cents: 6,
      cache_hit: 1,
      latency_ms: 2100,
    })
    render(<LogStream events={[EVENTS[0], turn]} status="open" count={2} />)
    const seal = screen.getByTestId('trace-turn')
    expect(seal).toHaveTextContent('opus-4-8')
    expect(seal).toHaveTextContent('18,400 tok')
    expect(seal).toHaveTextContent('cache✓')
    // the turn row is the seal — NOT one of the action lines
    expect(screen.getAllByTestId('trace-line')).toHaveLength(1)
  })
})
