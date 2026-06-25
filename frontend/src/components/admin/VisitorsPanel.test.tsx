import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AdminAttributionReport } from '~/lib/use-admin'

import { VisitorsPanel } from './VisitorsPanel'

const REPORT: AdminAttributionReport = {
  links: [
    {
      code: 'out1',
      artifactType: 'outreach',
      company: 'anthropic.com',
      recipient: 'jane@anthropic.com',
      createdAt: '2026-06-16T10:00:00Z',
      clicks: 3,
      uniqueVisitors: 2,
      lastClickAt: '2026-06-16T12:00:00Z',
    },
  ],
  recentVisits: [
    {
      ts: '2026-06-16T12:00:00Z',
      linkCode: 'out1',
      company: 'anthropic.com',
      country: 'US',
      uaClass: 'desktop',
      referrer: null,
    },
  ],
  summary: {
    totalLinks: 1,
    totalClicks: 3,
    totalUniqueVisitors: 2,
    byArtifact: { outreach: 1 },
    topCountries: [{ country: 'US', clicks: 3 }],
  },
}

describe('VisitorsPanel', () => {
  it('renders the stat strip + the links and recent-visits tables', () => {
    render(<VisitorsPanel data={REPORT} />)
    expect(screen.getByText('Outreach email')).toBeInTheDocument()
    expect(screen.getByText('/r/out1')).toBeInTheDocument()
    expect(screen.getAllByText('anthropic.com').length).toBeGreaterThan(0)
    // a null referrer renders as 'direct'
    expect(screen.getByText('direct')).toBeInTheDocument()
  })

  it('renders the empty note with no data', () => {
    render(<VisitorsPanel data={null} />)
    expect(screen.getByText('No attribution data yet.')).toBeInTheDocument()
  })

  it('sorts the links table by Clicks on header click (desc-first)', () => {
    const many: AdminAttributionReport = {
      ...REPORT,
      links: [
        { ...REPORT.links[0], code: 'a', company: 'Acorn', clicks: 1, uniqueVisitors: 1 },
        { ...REPORT.links[0], code: 'b', company: 'Bolt', clicks: 9, uniqueVisitors: 5 },
      ],
    }
    render(<VisitorsPanel data={many} />)
    const linkOrder = () =>
      screen
        .getAllByRole('row')
        .map((r) => r.textContent ?? '')
        .filter((t) => /Acorn|Bolt/.test(t))
        .map((t) => (/Bolt/.test(t) ? 'Bolt' : 'Acorn'))
    expect(linkOrder()).toEqual(['Acorn', 'Bolt']) // incoming order

    fireEvent.click(screen.getByTestId('datatable-sort-clicks')) // desc → most clicks first
    expect(linkOrder()).toEqual(['Bolt', 'Acorn'])
  })
})
