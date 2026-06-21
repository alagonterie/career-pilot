import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PipelineApplication } from '~/lib/use-pipeline'

// Isolate from the router — the home variant renders a <Link> (the SimFallback /
// panels.test pattern). An anchor stand-in keeps the text + role assertable.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}))

import { ConcludedBanner, pickAcceptedCompany } from './ConcludedBanner'

function app(stage: string, opts: Partial<PipelineApplication> = {}): PipelineApplication {
  return {
    application_id: `id-${stage}-${Math.random()}`,
    application_ref: 'infra-a',
    public_state: 'obfuscated',
    role_title: null,
    status: 'active',
    stage,
    applied_at: null,
    stage_entered_at: null,
    last_activity_at: null,
    win_confidence: null,
    win_confidence_rationale: null,
    published_learning: null,
    days_in_stage: null,
    days_in_pipeline: null,
    ...opts,
  }
}

describe('pickAcceptedCompany (§24.149 L2 / D4 — anonymized unless public)', () => {
  it('brackets an obfuscated offer ref', () => {
    expect(pickAcceptedCompany([app('applied'), app('offer', { application_ref: 'infra-a' })])).toBe('[infra-a]')
  })

  it('shows a public (revealed) offer ref unbracketed', () => {
    expect(pickAcceptedCompany([app('offer', { application_ref: 'Acme', public_state: 'public' })])).toBe('Acme')
  })

  it('is null when no application reached the offer stage', () => {
    expect(pickAcceptedCompany([app('applied'), app('rejected')])).toBeNull()
  })
})

describe('ConcludedBanner', () => {
  it('names the accepted company (anonymized) and links to the pipeline on home', () => {
    render(<ConcludedBanner apps={[app('offer', { application_ref: 'infra-a' })]} showPipelineLink />)
    const banner = screen.getByTestId('concluded-banner')
    expect(banner).toHaveTextContent(/search concluded/i)
    expect(banner).toHaveTextContent('[infra-a]')
    expect(within(banner).getByText(/see the full pipeline/i)).toBeInTheDocument()
  })

  it('stays generic with no offer row and omits the pipeline link off home', () => {
    render(<ConcludedBanner apps={[app('applied')]} />)
    const banner = screen.getByTestId('concluded-banner')
    expect(banner).toHaveTextContent(/i accepted an offer/i)
    expect(within(banner).queryByText(/see the full pipeline/i)).not.toBeInTheDocument()
  })
})
