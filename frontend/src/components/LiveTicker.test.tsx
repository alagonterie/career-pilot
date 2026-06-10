import { render, screen } from '@testing-library/react'
import type * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { AuditEvent } from '~/lib/use-activity-stream'

// Isolate from the router — the ticker [ref] is a <Link> into the /pipeline
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
    cache_read_pct: null,
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
            summary: 'digging in',
          }),
        ]}
      />,
    )
    expect(screen.getByText('research-company')).toBeInTheDocument()
    expect(screen.getByTestId('proactive-marker')).toBeInTheDocument()
    expect(screen.getByText('opus-4-7')).toBeInTheDocument()
  })

  it('prefixes the date on an event from a previous day, plain HH:MM today (§24.57)', () => {
    render(
      <LiveTicker
        status="open"
        events={[
          ev({ seq: 1, ts: '2026-06-02T16:42:00Z', summary: 'older' }),
          ev({ seq: 2, ts: new Date().toISOString(), summary: 'fresh' }),
        ]}
      />,
    )
    const rows = screen.getAllByTestId('ticker-row')
    expect(rows[0]).toHaveTextContent(/Jun 2 \d{2}:\d{2}/)
    expect(rows[1]).not.toHaveTextContent(/[A-Z][a-z]{2} \d/)
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
    // category is the fallback source label when agent_name is null, aliased for
    // display (the 'funnel' category renders as 'pipeline' — §5.2 / §8.1 / §24.59)
    expect(screen.getByText('pipeline')).toBeInTheDocument()
  })

  it('renders [ref] as a deep-link into that application’s /pipeline drawer (§24.60)', () => {
    render(
      <LiveTicker
        status="open"
        events={[ev({ seq: 1, category: 'funnel', application_ref: 'fintech-a', summary: 'advanced' })]}
      />,
    )
    const link = screen.getByTestId('ticker-ref-link')
    expect(link).toHaveAttribute('href', '/pipeline?app=fintech-a')
    expect(link).toHaveTextContent('[fintech-a]')
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
