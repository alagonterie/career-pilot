import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { PipelineApplication } from '~/lib/use-pipeline'
import type { TelemetryView } from '~/lib/use-telemetry'

// Isolate from the router — RecentOutcomesPanel rows are <Link>s (the §24.57
// /pipeline deep-link), which would need a RouterProvider. An anchor stand-in
// keeps the content + testids assertable (the SimFallback.test pattern).
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    'data-testid': testId,
  }: {
    children?: React.ReactNode
    className?: string
    'data-testid'?: string
  }) => (
    <a className={className} data-testid={testId}>
      {children}
    </a>
  ),
}))

import { PipelineCompact } from './PipelineCompact'
import {
  ContainerPoolPanel,
  Panel,
  RecentOutcomesPanel,
  SessionsPanel,
  SystemStatusStrip,
  TelemetryPanel,
} from './panels'

const ARCH: ArchitectureData = {
  sessions: { active: 2, running: 2 },
  containers: { running: 2, capacity_max: 4, memory_mb_each: 512, runtime: 'up' },
  backend: 'online',
}
const MODE: SystemMode = { live_mode: true, pause_state: 'active', pause_reason: null, backend: 'online' }
const LOCAL = {
  simulator_runs_total: 0,
  activity_events_total: 3,
  activity_events_24h: 1,
  last_activity_at: '2026-06-16T10:00:00.000Z',
  turns_total: 2,
  turns_24h: 1,
  turn_cost_cents_total: 10,
  turn_cost_cents_24h: 4,
  sim_cost_cents_total: 50,
  sim_cost_cents_24h: 24,
  cache_hit_rate: 0.66,
  turn_p50_ms: 15000,
  turn_p95_ms: 31000,
  top_model: 'claude-haiku-4-5',
}

function app(p: Partial<PipelineApplication> & { application_ref: string; stage: string }): PipelineApplication {
  return {
    application_id: p.application_ref,
    public_state: 'obfuscated',
    role_title: null,
    status: 'APPLIED',
    applied_at: null,
    stage_entered_at: null,
    last_activity_at: null,
    win_confidence: null,
    win_confidence_rationale: null,
    published_learning: null,
    days_in_stage: null,
    days_in_pipeline: null,
    ...p,
  }
}

const APPS: PipelineApplication[] = [
  app({ application_ref: 'fintech-a', stage: 'applied', last_activity_at: '2026-05-14T09:00:00Z' }),
  app({
    application_ref: 'devtools-b',
    stage: 'offer',
    public_state: 'public',
    last_activity_at: '2026-05-25T09:00:00Z',
  }),
]

describe('SystemStatusStrip', () => {
  it('shows the mode + agent state (unboxed header strip; no redundant backend dot)', () => {
    render(<SystemStatusStrip mode={MODE} />)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('RUNNING')).toBeInTheDocument() // pause_state 'active' → RUNNING
    expect(screen.queryByText(/backend online/)).not.toBeInTheDocument() // dropped — was tautological
  })
})

describe('SessionsPanel + ContainerPoolPanel', () => {
  it('renders live session counts', () => {
    render(<SessionsPanel arch={ARCH} />)
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('renders running/max + memory utilization', () => {
    render(<ContainerPoolPanel arch={ARCH} />)
    expect(screen.getByText('2 / 4')).toBeInTheDocument()
    expect(screen.getByText(/1024 MB used/)).toBeInTheDocument()
  })

  it('reports a down runtime honestly', () => {
    render(
      <ContainerPoolPanel arch={{ ...ARCH, containers: { ...ARCH.containers, running: null, runtime: 'down' } }} />,
    )
    expect(screen.getByText('down')).toBeInTheDocument()
  })
})

describe('TelemetryPanel', () => {
  it('renders the local-derived lanes (turns, p50/p95 in seconds, top model) when turns exist (§24.47)', () => {
    const view: TelemetryView = { local: LOCAL, hasTurns: true }
    render(<TelemetryPanel view={view} />)
    expect(screen.getByText('15s')).toBeInTheDocument() // p50, whole seconds (fits the cell)
    expect(screen.getByText('31s')).toBeInTheDocument() // p95
    expect(screen.getByText(/claude-haiku-4-5/)).toBeInTheDocument()
    expect(screen.getByText('3 total')).toBeInTheDocument() // local activity line still renders
    expect(screen.queryByText('66%')).not.toBeInTheDocument() // cache rate lives in LLM spend, not here
  })

  it('shows the honest "awaiting first turn" state when no turns are captured', () => {
    const view: TelemetryView = { local: { ...LOCAL, turns_total: 0 }, hasTurns: false }
    render(<TelemetryPanel view={view} />)
    expect(screen.getByTestId('telemetry-pending')).toBeInTheDocument()
    expect(screen.getByText('3 total')).toBeInTheDocument() // local aggregates still render
  })
})

describe('Panel', () => {
  it('renders a page-supplied header action (the open-link slot — §24.35 Pass A)', () => {
    render(
      <Panel title="Job Pipeline" action={<a href="/pipeline">open →</a>}>
        <p>body</p>
      </Panel>,
    )
    expect(screen.getByRole('heading', { name: 'Job Pipeline' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/pipeline')
  })
})

describe('PipelineCompact + RecentOutcomes', () => {
  it('counts stages + reveals a public offer', () => {
    render(<PipelineCompact apps={APPS} />)
    expect(within(screen.getByTestId('funnel-compact-applied')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTestId('funnel-compact-offer')).getByText('1')).toBeInTheDocument()
    expect(screen.getByTestId('funnel-compact-reveal')).toHaveTextContent('devtools-b')
  })

  it('holds its shape with skeletons while loading (no counts, no reveal)', () => {
    render(<PipelineCompact apps={[]} loading />)
    // all 5 stage cells still render (the strip keeps its shape) …
    expect(screen.getByTestId('funnel-compact-applied')).toBeInTheDocument()
    expect(screen.getByTestId('funnel-compact-offer')).toBeInTheDocument()
    // … but as skeletons, not counts, and the reveal line is suppressed
    expect(within(screen.getByTestId('funnel-compact-applied')).queryByText('0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('funnel-compact-reveal')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(5)
  })

  it('lists recent outcomes newest-first with the public marker', () => {
    render(<RecentOutcomesPanel apps={APPS} />)
    const items = within(screen.getByTestId('recent-outcomes')).getAllByRole('listitem')
    // devtools-b (05-25) is more recent than fintech-a (05-14) → first
    expect(items[0]).toHaveTextContent('devtools-b')
    expect(items[1]).toHaveTextContent('[fintech-a]')
  })

  it('renders each outcome as a deep-link into the /pipeline drawer (§24.57)', () => {
    render(<RecentOutcomesPanel apps={APPS} />)
    expect(screen.getAllByTestId('recent-outcome-link')).toHaveLength(2)
  })
})

describe('InfoTip explainers on the metric jargon (§24.57)', () => {
  it('TelemetryPanel carries an info trigger on turn p50', () => {
    const view: TelemetryView = { local: LOCAL, hasTurns: true }
    render(<TelemetryPanel view={view} />)
    expect(screen.getByLabelText('About: turn p50')).toBeInTheDocument()
  })
})

describe('§24.62 layout-stability polish', () => {
  it('Metric labels never wrap (the TURN P50 two-line regression)', () => {
    const view: TelemetryView = { local: LOCAL, hasTurns: true }
    render(<TelemetryPanel view={view} />)
    const label = screen.getByText('turn p50')
    expect(label).toHaveClass('whitespace-nowrap')
  })

  it('SessionsPanel explains both counts via InfoTips', () => {
    render(<SessionsPanel arch={ARCH} />)
    fireEvent.click(screen.getByRole('button', { name: 'About: running' }))
    expect(screen.getByTestId('info-tip-panel')).toHaveTextContent(/idle out between turns and respawn/i)
    fireEvent.click(screen.getByRole('button', { name: 'About: running' })) // re-tap closes (jsdom gets no outside-click)
    fireEvent.click(screen.getByRole('button', { name: 'About: active' }))
    expect(screen.getByTestId('info-tip-panel')).toHaveTextContent(/each an isolated session with its own container/i)
  })

  it('SessionsPanel carries the session-definition footer line', () => {
    render(<SessionsPanel arch={ARCH} />)
    expect(screen.getByText('1 session = 1 conversation in its own container')).toBeInTheDocument()
  })
})
