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

  it('shows a starting message before any trace arrives', () => {
    render(<SimActivity trace={[]} status="running" cost_usd={null} />)
    expect(screen.getByTestId('sim-activity-empty')).toHaveTextContent('starting')
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
})
