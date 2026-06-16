import { fireEvent, render, screen, within } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { FunnelApplication } from '~/lib/use-funnel'

// Isolate from the router — DetailPanel's "Live activity →" is a <Link>
// (§24.60), which would need a RouterProvider. The anchor stand-in builds the
// href from to+search so the link target stays assertable.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    className,
    'data-testid': testId,
  }: {
    to?: string
    search?: Record<string, string | undefined>
    children?: React.ReactNode
    className?: string
    'data-testid'?: string
  }) => {
    const qs = Object.entries(search ?? {})
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    return (
      <a href={qs ? `${to}?${qs}` : to} className={className} data-testid={testId}>
        {children}
      </a>
    )
  },
}))

import { DetailPanel } from './DetailPanel'
import { FunnelBoard } from './FunnelBoard'
import { FunnelCard } from './FunnelCard'
import { StatTiles } from './StatTiles'

function app(p: Partial<FunnelApplication> & { application_ref: string }): FunnelApplication {
  return {
    application_id: p.application_ref, // tests use unique refs; an explicit application_id in `p` overrides
    public_state: 'obfuscated',
    role_title: 'Senior Software Engineer',
    status: 'APPLIED',
    stage: 'applied',
    applied_at: '2026-05-01T00:00:00Z',
    stage_entered_at: '2026-05-01T00:00:00Z',
    last_activity_at: null,
    win_confidence: null,
    win_confidence_rationale: null,
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

  it('renders two applications that share an obfuscated label (distinct ids, no key/layoutId collision)', () => {
    // Two roles at one company → same application_ref, different application_id.
    // Keying by application_id (not the ref) keeps both cards; the old
    // ref-keyed version collided and glitched the motion layout animation.
    render(
      <FunnelBoard
        apps={[
          app({ application_id: 'id-1', application_ref: 'series-b-ai', stage: 'screening' }),
          app({ application_id: 'id-2', application_ref: 'series-b-ai', stage: 'screening' }),
        ]}
        onSelect={() => {}}
      />,
    )
    const col = screen.getByTestId('funnel-col-screening')
    expect(within(col).getAllByText('[series-b-ai]')).toHaveLength(2)
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

  it('keeps the Bookmarked & closed strip with an honest note when nothing is closed (§24.62)', () => {
    const pipelineOnly = APPS.filter((a) => a.stage !== 'rejected')
    render(<FunnelBoard apps={pipelineOnly} onSelect={() => {}} />)
    expect(screen.getByTestId('funnel-offboard')).toBeInTheDocument()
    expect(screen.getByTestId('funnel-offboard-empty')).toHaveTextContent('Nothing bookmarked or closed yet.')
  })

  it('calls onSelect with the clicked application', () => {
    const onSelect = vi.fn()
    render(<FunnelBoard apps={APPS} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('[fintech-a]'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].application_ref).toBe('fintech-a')
  })

  it('collapses an empty stage on mobile — its body is hidden < sm (§24.37)', () => {
    // Only an offer card; applied/screening/tech/final are empty. On a phone the
    // board stacks vertically, so an empty stage's "—" body is `hidden sm:flex`
    // (the section collapses to its header row — no full-height void).
    render(<FunnelBoard apps={[app({ application_ref: 'x', stage: 'offer' })]} onSelect={() => {}} />)
    const dash = within(screen.getByTestId('funnel-col-applied')).getByText('—')
    expect(dash.parentElement?.className).toContain('hidden')
    // A populated stage keeps its card (not collapsed).
    expect(within(screen.getByTestId('funnel-col-offer')).getByText('[x]')).toBeInTheDocument()
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

describe('FunnelCard kit chip (§24.65)', () => {
  const kit = (round: string, status = 'active') => ({
    round,
    interview_type: 'technical_screen',
    interview_at: null,
    status,
    created_at: '2026-06-01T00:00:00Z',
    has_content: true,
  })

  it('shows the ▤ chip when kits exist (count when several)', () => {
    render(<FunnelCard app={app({ application_ref: 'x', interview_kits: [kit('TECH_SCREEN')] })} onSelect={() => {}} />)
    expect(screen.getByTestId('funnel-card-kit')).toHaveTextContent('▤ kit')

    render(
      <FunnelCard
        app={app({ application_ref: 'y', interview_kits: [kit('SCREENING', 'archived'), kit('TECH_SCREEN')] })}
        onSelect={() => {}}
      />,
    )
    expect(screen.getAllByTestId('funnel-card-kit')[1]).toHaveTextContent('▤ 2 kits')
  })

  it('shows no chip without kits', () => {
    render(<FunnelCard app={app({ application_ref: 'z' })} onSelect={() => {}} />)
    expect(screen.queryByTestId('funnel-card-kit')).not.toBeInTheDocument()
  })
})

describe('StatTiles', () => {
  it('renders the four labeled tiles', () => {
    render(<StatTiles apps={APPS} />)
    for (const label of ['Applications YTD', 'Interviews this month', 'Offers', 'Avg days active']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getAllByTestId('stat-value')).toHaveLength(4)
  })

  it('each tile carries an InfoTip that opens its honest derivation (§24.60)', () => {
    render(<StatTiles apps={APPS} />)
    expect(screen.getAllByTestId('info-tip-trigger')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'About: Avg days active' }))
    expect(screen.getByTestId('info-tip-panel')).toHaveTextContent(/closed applications.*excluded.*heuristic/i)
  })
})

describe('DetailPanel', () => {
  it('renders nothing when no application is selected', () => {
    render(<DetailPanel app={null} onClose={() => {}} />)
    expect(screen.queryByTestId('funnel-detail')).not.toBeInTheDocument()
  })

  it('shows the anonymized facts + the labeled win-confidence estimate', () => {
    render(<DetailPanel app={APPS[4]} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Wayne Enterprises' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('84%')).toBeInTheDocument()
    // §24.73: the score is attributed to the host win-confidence model, with the
    // honest "an estimate … not a promise" framing carried in the marker's trail.
    expect(screen.getByTestId('agent-ref')).toHaveAttribute('data-actor', 'win-confidence')
    expect(screen.getByText(/not a promise/i)).toBeInTheDocument()
  })

  it('renders the Gen-AI rationale for the win-confidence score when present', () => {
    render(
      <DetailPanel
        app={app({
          application_ref: 'x',
          stage: 'offer',
          win_confidence: 97,
          win_confidence_rationale: 'Offer extended after a strong final round — essentially decided.',
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('win-rationale')).toHaveTextContent('Offer extended after a strong final round')
  })

  it('closes via the close button and Escape', () => {
    const onClose = vi.fn()
    render(<DetailPanel app={APPS[0]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('explains win confidence via an InfoTip — heuristic, not a probability (§24.60)', () => {
    render(<DetailPanel app={APPS[4]} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'About: win confidence' }))
    expect(screen.getByTestId('info-tip-panel')).toHaveTextContent(/heuristic, not a probability/i)
  })

  it('omits the win-confidence InfoTip when there is no score to explain', () => {
    render(<DetailPanel app={APPS[0]} onClose={() => {}} />) // win_confidence null
    expect(screen.queryByRole('button', { name: 'About: win confidence' })).not.toBeInTheDocument()
  })

  it('links to this application’s filtered /live activity (§24.60)', () => {
    render(<DetailPanel app={APPS[4]} onClose={() => {}} />)
    expect(screen.getByTestId('detail-live-link')).toHaveAttribute('href', '/live?app=Wayne Enterprises')
  })

  it('lists interview kits — incl. archived — linking into the /kit dossier (§24.65)', () => {
    render(
      <DetailPanel
        app={app({
          application_ref: 'ai-infra-a',
          stage: 'tech',
          interview_kits: [
            {
              round: 'SCREENING',
              interview_type: 'recruiter_screen',
              interview_at: '2026-05-06T17:00:00Z',
              status: 'archived',
              created_at: '2026-05-01T00:00:00Z',
              has_content: true,
            },
            {
              round: 'TECH_SCREEN',
              interview_type: 'technical_screen',
              interview_at: '2026-06-18T16:00:00Z',
              status: 'active',
              created_at: '2026-06-01T00:00:00Z',
              has_content: true,
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    const section = screen.getByTestId('detail-kits')
    const links = within(section).getAllByTestId('detail-kit-link')
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveAttribute('href', '/kit?app=ai-infra-a&round=SCREENING')
    expect(links[0]).toHaveTextContent('Recruiter screen')
    expect(links[0]).toHaveTextContent('archived')
    expect(links[1]).toHaveAttribute('href', '/kit?app=ai-infra-a&round=TECH_SCREEN')
    expect(links[1]).toHaveTextContent('Technical screen')
    expect(links[1]).toHaveTextContent('Jun 18')
    // The section explains itself (what a kit is + the sealing model).
    fireEvent.click(within(section).getByRole('button', { name: 'About: interview prep' }))
    expect(screen.getByTestId('info-tip-panel')).toHaveTextContent(/sealed while the process is live/i)
  })

  it('omits the Interview prep section when the application has no kits', () => {
    render(<DetailPanel app={APPS[0]} onClose={() => {}} />)
    expect(screen.queryByTestId('detail-kits')).not.toBeInTheDocument()
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

  it('restores focus to the triggering card when the panel closes (§24.36 36.2)', () => {
    render(<Harness />)
    const card = screen.getByText('Wayne Enterprises').closest('button') as HTMLButtonElement
    card.focus() // the card is focused when it's activated
    fireEvent.click(card)
    expect(screen.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('funnel-detail')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(card)
  })
})
