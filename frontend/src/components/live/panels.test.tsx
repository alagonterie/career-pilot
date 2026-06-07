import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { FunnelApplication } from '~/lib/use-funnel'
import type { TelemetryView } from '~/lib/use-telemetry'

import { FunnelCompact } from './FunnelCompact'
import {
  ContainerPoolPanel,
  CostCachePanel,
  Panel,
  RecentOutcomesPanel,
  SessionsPanel,
  SystemStatusPanel,
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
  turns_total: 2,
  turns_24h: 1,
  turn_cost_cents_total: 10,
  turn_cost_cents_24h: 4,
  cache_hit_rate: 0.66,
  turn_p50_ms: 15000,
  turn_p95_ms: 31000,
  top_model: 'claude-haiku-4-5',
}

function app(p: Partial<FunnelApplication> & { application_ref: string; stage: string }): FunnelApplication {
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

const APPS: FunnelApplication[] = [
  app({ application_ref: 'fintech-a', stage: 'applied', last_activity_at: '2026-05-14T09:00:00Z' }),
  app({
    application_ref: 'devtools-b',
    stage: 'offer',
    public_state: 'public',
    last_activity_at: '2026-05-25T09:00:00Z',
  }),
]

describe('SystemStatusPanel', () => {
  it('shows the mode + backend health', () => {
    render(<SystemStatusPanel mode={MODE} arch={ARCH} />)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE')).toBeInTheDocument()
    expect(screen.getByText(/backend online/)).toBeInTheDocument()
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
    expect(screen.getByText('15.0s')).toBeInTheDocument() // p50, seconds-formatted (fits the cell)
    expect(screen.getByText('31.0s')).toBeInTheDocument() // p95
    expect(screen.getByText(/claude-haiku-4-5/)).toBeInTheDocument()
    expect(screen.getByText('3 total')).toBeInTheDocument() // local activity line still renders
    expect(screen.queryByText('66%')).not.toBeInTheDocument() // cache lives in the Cost panel only
  })

  it('shows the honest "awaiting first turn" state when no turns are captured', () => {
    const view: TelemetryView = { local: { ...LOCAL, turns_total: 0 }, hasTurns: false }
    render(<TelemetryPanel view={view} />)
    expect(screen.getByTestId('telemetry-pending')).toBeInTheDocument()
    expect(screen.getByText('3 total')).toBeInTheDocument() // local aggregates still render
  })
})

describe('CostCachePanel', () => {
  it('shows the estimated spend + cache line from local turn data when turns exist (§24.47)', () => {
    const view: TelemetryView = { local: LOCAL, hasTurns: true }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('local-spend')).toHaveTextContent('$0.10') // 10 cents total, est
    expect(screen.getByText(/66% of prompt tokens/)).toBeInTheDocument()
    expect(screen.getByText('$0.04 today')).toBeInTheDocument()
  })

  it('shows the honest pending state when no turns are captured', () => {
    const view: TelemetryView = { local: { ...LOCAL, turns_total: 0 }, hasTurns: false }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('cost-pending')).toBeInTheDocument()
  })
})

describe('Panel', () => {
  it('renders a page-supplied header action (the open-link slot — §24.35 Pass A)', () => {
    render(
      <Panel title="Momentum" action={<a href="/momentum">open →</a>}>
        <p>body</p>
      </Panel>,
    )
    expect(screen.getByRole('heading', { name: 'Momentum' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/momentum')
  })
})

describe('FunnelCompact + RecentOutcomes', () => {
  it('counts stages + reveals a public offer', () => {
    render(<FunnelCompact apps={APPS} />)
    expect(within(screen.getByTestId('funnel-compact-applied')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTestId('funnel-compact-offer')).getByText('1')).toBeInTheDocument()
    expect(screen.getByTestId('funnel-compact-reveal')).toHaveTextContent('devtools-b')
  })

  it('holds its shape with skeletons while loading (no counts, no reveal)', () => {
    render(<FunnelCompact apps={[]} loading />)
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
})
