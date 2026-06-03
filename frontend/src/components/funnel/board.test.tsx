import { fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { FunnelApplication } from '~/lib/use-funnel'

import { DetailPanel } from './DetailPanel'
import { FunnelBoard } from './FunnelBoard'
import { FunnelCard } from './FunnelCard'
import { StatTiles } from './StatTiles'

function app(p: Partial<FunnelApplication> & { application_ref: string }): FunnelApplication {
  return {
    public_state: 'obfuscated',
    role_title: 'Senior Software Engineer',
    status: 'APPLIED',
    stage: 'applied',
    applied_at: '2026-05-01T00:00:00Z',
    stage_entered_at: '2026-05-01T00:00:00Z',
    last_activity_at: null,
    win_confidence: null,
    published_learning: null,
    days_in_stage: 4,
    days_in_pipeline: 12,
    ...p,
  }
}

const APPS: FunnelApplication[] = [
  app({ application_ref: 'fintech-a', stage: 'applied' }),
  app({ application_ref: 'fintech-b', stage: 'screening' }),
  app({ application_ref: 'ai-infra-a', stage: 'tech' }),
  app({ application_ref: 'devtools-a', stage: 'final' }),
  app({ application_ref: 'Wayne Enterprises', stage: 'offer', public_state: 'public', win_confidence: 84 }),
  app({ application_ref: 'saas-b', stage: 'rejected' }),
]

describe('FunnelBoard', () => {
  it('renders a column per pipeline stage with the cards in them', () => {
    render(<FunnelBoard apps={APPS} onSelect={() => {}} />)
    for (const title of ['Applied', 'Screening', 'Tech', 'Final', 'Offer']) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument()
    }
    expect(screen.getByText('[fintech-a]')).toBeInTheDocument()
  })

  it('obfuscates by default but reveals the public application with its real name', () => {
    render(<FunnelBoard apps={APPS} onSelect={() => {}} />)
    // Obfuscated → bracketed label, no real name leaked.
    expect(screen.getByText('[fintech-b]')).toBeInTheDocument()
    // Public reveal → real company name + the ◆ public marker.
    expect(screen.getByText('Wayne Enterprises')).toBeInTheDocument()
    expect(screen.getByTestId('reveal-marker')).toBeInTheDocument()
  })

  it('surfaces closed/non-pipeline applications rather than dropping them', () => {
    render(<FunnelBoard apps={APPS} onSelect={() => {}} />)
    expect(screen.getByTestId('funnel-offboard')).toBeInTheDocument()
    expect(screen.getByText('[saas-b]')).toBeInTheDocument()
  })

  it('calls onSelect with the clicked application', () => {
    const onSelect = vi.fn()
    render(<FunnelBoard apps={APPS} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('[fintech-a]'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].application_ref).toBe('fintech-a')
  })
})

describe('FunnelCard win-confidence bar (§24.35 Pass D)', () => {
  it('shows the ~N% win-confidence bar when present (not the stage position)', () => {
    render(
      <FunnelCard app={app({ application_ref: 'x', stage: 'screening', win_confidence: 64 })} onSelect={() => {}} />,
    )
    expect(screen.getByText('~64%')).toBeInTheDocument()
  })

  it('shows no bar when win_confidence is null', () => {
    const { container } = render(
      <FunnelCard app={app({ application_ref: 'y', win_confidence: null })} onSelect={() => {}} />,
    )
    expect(container.querySelector('[title*="win confidence"]')).toBeNull()
  })
})

describe('StatTiles', () => {
  it('renders the four labeled tiles', () => {
    render(<StatTiles apps={APPS} />)
    for (const label of ['Applications YTD', 'Interviews this month', 'Offers', 'Avg days in funnel']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getAllByTestId('stat-value')).toHaveLength(4)
  })
})

describe('DetailPanel', () => {
  it('renders nothing when no application is selected', () => {
    render(<DetailPanel app={null} onClose={() => {}} />)
    expect(screen.queryByTestId('funnel-detail')).not.toBeInTheDocument()
  })

  it('shows the anonymized facts + the labeled win-confidence heuristic', () => {
    render(<DetailPanel app={APPS[4]} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Wayne Enterprises' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('84%')).toBeInTheDocument()
    expect(screen.getByText(/low-rigor heuristic/i)).toBeInTheDocument()
  })

  it('closes via the close button and Escape', () => {
    const onClose = vi.fn()
    render(<DetailPanel app={APPS[0]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('card click opens the detail panel (composed)', () => {
  function Harness() {
    const [selected, setSelected] = React.useState<FunnelApplication | null>(null)
    return (
      <>
        <FunnelBoard apps={APPS} onSelect={setSelected} />
        <DetailPanel app={selected} onClose={() => setSelected(null)} />
      </>
    )
  }

  it('opens the panel for the clicked application', () => {
    render(<Harness />)
    expect(screen.queryByTestId('funnel-detail')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Wayne Enterprises'))
    expect(screen.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeInTheDocument()
  })
})
