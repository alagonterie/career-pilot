import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AuditEvent } from '~/lib/use-activity-stream'

import { LiveTicker } from './LiveTicker'

function ev(partial: Partial<AuditEvent> & { seq: number }): AuditEvent {
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
    ...partial,
  }
}

describe('LiveTicker', () => {
  it('shows a connected-but-empty state when open with no events (§24.36 36.1)', () => {
    render(<LiveTicker events={[]} status="open" />)
    expect(screen.getByTestId('ticker-empty')).toHaveTextContent(/no agent activity/i)
  })

  it('shows a connecting affordance before the stream opens (§24.36 36.1)', () => {
    render(<LiveTicker events={[]} status="idle" />)
    expect(screen.getByTestId('ticker-empty')).toHaveTextContent(/connecting/i)
  })

  it('shows an offline message when reconnecting with no events', () => {
    render(<LiveTicker events={[]} status="reconnecting" />)
    expect(screen.getByTestId('ticker-empty')).toHaveTextContent(/offline/i)
  })

  it('renders agent_name + the ◆ proactive marker + telemetry lanes when present', () => {
    render(
      <LiveTicker
        status="open"
        events={[
          ev({
            seq: 2,
            category: 'subagent_progress',
            agent_name: 'research-company',
            proactive: 1,
            model_used: 'opus-4-7',
            cache_hit: 1,
            summary: 'digging in',
          }),
        ]}
      />,
    )
    expect(screen.getByText('research-company')).toBeInTheDocument()
    expect(screen.getByTestId('proactive-marker')).toBeInTheDocument()
    expect(screen.getByText('opus-4-7')).toBeInTheDocument()
    expect(screen.getByText('(cache hit)')).toBeInTheDocument()
  })

  it('omits absent lanes (progressive rendering — never faked data)', () => {
    render(
      <LiveTicker
        status="open"
        events={[ev({ seq: 1, category: 'funnel', application_ref: 'fintech-a', summary: 'advanced to screening' })]}
      />,
    )
    expect(screen.getByText('[fintech-a]')).toBeInTheDocument()
    expect(screen.queryByTestId('proactive-marker')).not.toBeInTheDocument()
    expect(screen.queryByText('(cache hit)')).not.toBeInTheDocument()
    // category is the fallback label when agent_name is null
    expect(screen.getByText('funnel')).toBeInTheDocument()
  })

  it('renders a page-supplied header action (the watch-live link slot — §24.35 Pass A)', () => {
    // The slot is router-free: the page supplies the <Link>; a plain <a> proves
    // the component renders it without a router context.
    render(<LiveTicker events={[]} status="open" action={<a href="/live">watch live →</a>} />)
    expect(screen.getByRole('link', { name: /watch live/i })).toHaveAttribute('href', '/live')
  })

  it('drops category=turn rows — those are the /live cost story (§24.35 Pass C)', () => {
    render(
      <LiveTicker
        status="open"
        events={[
          ev({ seq: 1, category: 'funnel', summary: 'advanced to screening' }),
          ev({ seq: 2, category: 'turn', summary: 'turn complete', model_used: 'opus-4-8' }),
        ]}
      />,
    )
    expect(screen.getAllByTestId('ticker-row')).toHaveLength(1)
    expect(screen.queryByText('turn complete')).not.toBeInTheDocument()
  })
})
