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
})
