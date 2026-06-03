import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { FunnelApplication } from '~/lib/use-funnel'
import type { TelemetryView } from '~/lib/use-telemetry'

import { FunnelCompact } from './FunnelCompact'
import {
  ContainerPoolPanel,
  CostCachePanel,
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
  turn_cost_cents_total: 10,
  turn_cost_cents_24h: 4,
}

function app(p: Partial<FunnelApplication> & { application_ref: string; stage: string }): FunnelApplication {
  return {
    public_state: 'obfuscated',
    role_title: null,
    status: 'APPLIED',
    applied_at: null,
    stage_entered_at: null,
    last_activity_at: null,
    win_confidence: null,
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
  it('renders the honest "not connected" state + the real local aggregates when unavailable', () => {
    const view: TelemetryView = { available: false, reason: 'no Portkey key configured', summary: null, local: LOCAL }
    render(<TelemetryPanel view={view} />)
    expect(screen.getByTestId('telemetry-unavailable')).toHaveTextContent(/not connected/i)
    expect(screen.getByText('3 total')).toBeInTheDocument()
  })

  it('renders Portkey lanes when available', () => {
    const view: TelemetryView = {
      available: true,
      reason: null,
      summary: { total_requests: 1284, cache_hit_rate: 0.62, p50_latency_ms: 920, top_model: 'opus-4-8' },
      local: LOCAL,
    }
    render(<TelemetryPanel view={view} />)
    expect(screen.getByText('62%')).toBeInTheDocument()
    expect(screen.getByText('1,284')).toBeInTheDocument()
    expect(screen.getByText(/opus-4-8/)).toBeInTheDocument()
  })
})

describe('CostCachePanel', () => {
  it('shows spend when available', () => {
    const view: TelemetryView = {
      available: true,
      reason: null,
      summary: { total_cost_usd: 4.17, cache_hit_rate: 0.62 },
      local: null,
    }
    render(<CostCachePanel view={view} />)
    expect(screen.getByText('$4.17')).toBeInTheDocument()
  })

  it('shows the honest pending state when unavailable', () => {
    const view: TelemetryView = { available: false, reason: 'bypass', summary: null, local: null }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('cost-unavailable')).toBeInTheDocument()
  })

  it('shows the always-real local spend estimate even when Portkey is unavailable (§24.34)', () => {
    const view: TelemetryView = { available: false, reason: 'no Portkey key configured', summary: null, local: LOCAL }
    render(<CostCachePanel view={view} />)
    expect(screen.getByTestId('cost-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('local-spend')).toHaveTextContent('$0.10 est') // 10 cents
    expect(screen.getByText('2 turns')).toBeInTheDocument()
  })
})

describe('FunnelCompact + RecentOutcomes', () => {
  it('counts stages + reveals a public offer', () => {
    render(<FunnelCompact apps={APPS} />)
    expect(within(screen.getByTestId('funnel-compact-applied')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTestId('funnel-compact-offer')).getByText('1')).toBeInTheDocument()
    expect(screen.getByTestId('funnel-compact-reveal')).toHaveTextContent('devtools-b')
  })

  it('lists recent outcomes newest-first with the public marker', () => {
    render(<RecentOutcomesPanel apps={APPS} />)
    const items = within(screen.getByTestId('recent-outcomes')).getAllByRole('listitem')
    // devtools-b (05-25) is more recent than fintech-a (05-14) → first
    expect(items[0]).toHaveTextContent('devtools-b')
    expect(items[1]).toHaveTextContent('[fintech-a]')
  })
})
