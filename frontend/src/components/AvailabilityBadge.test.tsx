import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AvailabilityBadge } from './AvailabilityBadge'

describe('AvailabilityBadge (§24.120)', () => {
  it('defaults to "Open to offers" and carries the status + testid', () => {
    render(<AvailabilityBadge status="idle" data-testid="contact-status" />)
    const badge = screen.getByTestId('contact-status')
    expect(badge).toHaveTextContent('Open to offers')
    expect(badge).toHaveAttribute('data-status', 'idle')
  })

  it('reads "Offer accepted" with a steady (un-pulsed) dot in the concluded retrospective (§24.149 L2)', () => {
    render(<AvailabilityBadge status="open" concluded data-testid="hero-status" />)
    const badge = screen.getByTestId('hero-status')
    expect(badge).toHaveTextContent('Offer accepted')
    expect(badge).not.toHaveTextContent('Open to offers')
    expect(badge).toHaveAttribute('title', 'offer accepted')
    // Even with the feed "open", the concluded dot does NOT pulse (the search is over).
    expect(badge.querySelector('span[aria-hidden="true"]')?.className).not.toContain('cp-live-pulse')
  })

  it('pulses the dot only while the feed is connected (status="open")', () => {
    const { rerender } = render(<AvailabilityBadge status="open" data-testid="b" />)
    // The dot is the badge's aria-hidden child span.
    const dot = (sel: string) => screen.getByTestId('b').querySelector(sel)
    expect(dot('span[aria-hidden="true"]')?.className).toContain('cp-live-pulse')

    rerender(<AvailabilityBadge status="reconnecting" data-testid="b" />)
    expect(dot('span[aria-hidden="true"]')?.className).not.toContain('cp-live-pulse')
    expect(dot('span[aria-hidden="true"]')?.className).toContain('bg-muted-foreground')
  })

  it('uses the caller-supplied title (the home hero passes its live count)', () => {
    render(<AvailabilityBadge status="open" title="live — 3 events received" data-testid="hero-status" />)
    expect(screen.getByTestId('hero-status')).toHaveAttribute('title', 'live — 3 events received')
  })
})
