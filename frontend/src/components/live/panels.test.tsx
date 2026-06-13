import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { FunnelApplication } from '~/lib/use-funnel'
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

import { FunnelCompact } from './FunnelCompact'
import {
  ContainerPoolPanel,
  CostCachePanel,
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

describe('SystemStatusStrip', () => {
  it('shows the mode + backend health (unboxed header strip)', () => {
    render(<SystemStatusStrip mode={MODE} arch={ARCH} />)
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
    expect(screen.getByText('15s')).toBeInTheDocument() // p50, whole seconds (fits the cell)
    expect(screen.getByText('31s')).toBeInTheDocument() // p95
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
  it('shows the COMBINED estimated spend (agent turns + simulator) + cache line (§24.55)', () => {
    const view: TelemetryView = { local: LOCAL, hasTurns: true }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('local-spend')).toHaveTextContent('$0.60') // 10c turns + 50c sim
    expect(screen.getByText(/66% of prompt tokens/)).toBeInTheDocument()
    // the windowed line breaks today down by lane
    expect(screen.getByText('$0.28 today')).toBeInTheDocument() // 4c + 24c
    expect(screen.getByText('agent $0.04')).toBeInTheDocument()
    expect(screen.getByText('sim $0.24')).toBeInTheDocument()
  })

  it('renders the headline from simulator spend alone when no turns are captured (§24.55)', () => {
    const view: TelemetryView = {
      local: { ...LOCAL, turns_total: 0, turn_cost_cents_total: 0, turn_cost_cents_24h: 0 },
      hasTurns: false,
    }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('local-spend')).toHaveTextContent('$0.50')
    expect(screen.queryByTestId('cost-pending')).not.toBeInTheDocument()
  })

  it('shows the honest pending state when no spend at all is captured', () => {
    const view: TelemetryView = {
      local: {
        ...LOCAL,
        turns_total: 0,
        turn_cost_cents_total: 0,
        turn_cost_cents_24h: 0,
        sim_cost_cents_total: 0,
        sim_cost_cents_24h: 0,
      },
      hasTurns: false,
    }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('cost-pending')).toBeInTheDocument()
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

  it('renders each outcome as a deep-link into the /pipeline drawer (§24.57)', () => {
    render(<RecentOutcomesPanel apps={APPS} />)
    expect(screen.getAllByTestId('recent-outcome-link')).toHaveLength(2)
  })
})

describe('InfoTip explainers on the metric jargon (§24.57)', () => {
  it('CostCachePanel carries info triggers for spend · est and the cache rate', () => {
    const view: TelemetryView = { local: LOCAL, hasTurns: true }
    render(<CostCachePanel view={view} />)
    const triggers = screen.getAllByTestId('info-tip-trigger')
    expect(triggers.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByLabelText('About: spend · est')).toBeInTheDocument()
    expect(screen.getByLabelText('About: cache rate')).toBeInTheDocument()
  })

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
