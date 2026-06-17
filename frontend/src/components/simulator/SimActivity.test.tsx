import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SimTraceEvent } from '~/lib/use-simulator-run'

import { SimActivity } from './SimActivity'

const trace: SimTraceEvent[] = [
  { t: 'subagent', subagent: 'research-company', input_summary: 'digest Acme' },
  { t: 'tool', name: 'web_search', input_summary: '"Acme engineering"', parent_tool_use_id: 'tu' },
]

describe('SimActivity (PORTAL §5.3 trace pane)', () => {
  it('renders subagent + tool dispatch lines with their input summaries', () => {
    render(<SimActivity trace={trace} status="running" cost_usd={null} />)
    expect(screen.getByText('research-company')).toBeInTheDocument()
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText('digest Acme')).toBeInTheDocument()
  })

  it('indents a tool call made inside a subagent (parent_tool_use_id)', () => {
    render(<SimActivity trace={trace} status="running" cost_usd={null} />)
    const nested = screen.getByText('web_search').closest('li')
    expect(nested?.className).toContain('pl-5')
  })

  it('shows a run-level completion line with the single total cost when done', () => {
    render(<SimActivity trace={trace} status="done" cost_usd={0.041} />)
    const complete = screen.getByTestId('sim-trace-complete')
    expect(complete).toHaveTextContent('run complete')
    expect(complete).toHaveTextContent('$0.041')
  })

  it('shows a warming message + "starting" status before any trace arrives (§24.93)', () => {
    render(<SimActivity trace={[]} status="running" cost_usd={null} />)
    // Honest expectation-setting copy — no internal "sandbox session" jargon.
    expect(screen.getByTestId('sim-activity-empty')).toHaveTextContent('Spinning up a fresh sandbox')
    // The status claims "starting", not "running" — nothing is running yet.
    expect(screen.getByTestId('sim-activity-status')).toHaveTextContent('starting')
  })

  it('flips the status to "running" once the first trace arrives (§24.93)', () => {
    render(<SimActivity trace={trace} status="running" cost_usd={null} />)
    const status = screen.getByTestId('sim-activity-status')
    expect(status).toHaveTextContent('running')
    expect(status).not.toHaveTextContent('starting')
  })

  it('humanizes a raw-JSON input_summary into its salient field (§24.31 Δ)', () => {
    render(
      <SimActivity
        trace={[{ t: 'tool', name: 'WebSearch', input_summary: '{"query":"Stripe engineering blog 2026"}' }]}
        status="running"
        cost_usd={null}
      />,
    )
    expect(screen.getByText('“Stripe engineering blog 2026”')).toBeInTheDocument()
    expect(screen.queryByText(/\{"query"/)).not.toBeInTheDocument()
  })

  it('shows the elapsed ticker while running when startedAt is provided', () => {
    render(<SimActivity trace={trace} status="running" cost_usd={null} startedAt={Date.now() - 65_000} />)
    expect(screen.getByTestId('sim-elapsed')).toHaveTextContent(/1:0[5-9]/)
  })

  it('hides the ticker once done', () => {
    render(<SimActivity trace={trace} status="done" cost_usd={0.04} startedAt={Date.now() - 65_000} />)
    expect(screen.queryByTestId('sim-elapsed')).not.toBeInTheDocument()
  })

  it('badges adjacent subagent dispatches as parallel — and never a lone one (§5.3)', () => {
    const parallelTrace: SimTraceEvent[] = [
      { t: 'subagent', subagent: 'research-company' },
      { t: 'tool', name: 'WebSearch', parent_tool_use_id: 'tu' },
      { t: 'subagent', subagent: 'tailor-resume' },
      { t: 'subagent', subagent: 'draft-outreach' },
    ]
    render(<SimActivity trace={parallelTrace} status="running" cost_usd={null} />)
    const badges = screen.getAllByTestId('sim-trace-parallel')
    expect(badges).toHaveLength(2) // tailor-resume + draft-outreach, NOT research-company
    const researchLine = screen.getByText('research-company').closest('li')
    expect(researchLine?.querySelector('[data-testid="sim-trace-parallel"]')).toBeNull()
  })

  it('renders legacy Agent-named dispatches as subagent lines with their subagent_type (§24.31 Δ)', () => {
    // Traces persisted before the runner mapped the SDK's `Agent` tool to
    // t:'subagent' — the label and the parallel badge must still work.
    const legacy: SimTraceEvent[] = [
      {
        t: 'tool',
        name: 'Agent',
        input_summary: '{"subagent_type":"tailor-resume","description":"Rank + rewrite top bullets"}',
      },
      {
        t: 'tool',
        name: 'Agent',
        input_summary: '{"subagent_type":"draft-outreach","description":"Tone-matched cold email"}',
      },
    ]
    render(<SimActivity trace={legacy} status="running" cost_usd={null} />)
    expect(screen.getByText('tailor-resume')).toBeInTheDocument()
    expect(screen.getByText('draft-outreach')).toBeInTheDocument()
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('sim-trace-subagent')).toHaveLength(2)
    expect(screen.getAllByTestId('sim-trace-parallel')).toHaveLength(2)
  })
})
