import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdminAttributionLink, AdminAttributionReport } from '~/lib/use-admin'

import { VisitorsPanel } from './VisitorsPanel'

const BASE = 'https://hire.example.com'

function link(over: Partial<AdminAttributionLink>): AdminAttributionLink {
  return {
    code: 'out1',
    artifactType: 'outreach',
    company: 'anthropic.com',
    recipient: 'jane@anthropic.com',
    createdAt: '2026-06-16T10:00:00Z',
    expiresAt: null,
    clicks: 3,
    uniqueVisitors: 2,
    lastClickAt: '2026-06-16T12:00:00Z',
    ...over,
  }
}

const REPORT: AdminAttributionReport = {
  links: [link({})],
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

function okFetch(): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe('VisitorsPanel', () => {
  it('renders the stat strip + the links and recent-visits tables', () => {
    render(<VisitorsPanel data={REPORT} baseUrl={BASE} onSaved={() => {}} />)
    expect(screen.getByText('Outreach email')).toBeInTheDocument()
    expect(screen.getByText('/r/out1')).toBeInTheDocument()
    expect(screen.getAllByText('anthropic.com').length).toBeGreaterThan(0)
    expect(screen.getByText('direct')).toBeInTheDocument()
  })

  it('renders the empty note with no data', () => {
    render(<VisitorsPanel data={null} baseUrl={BASE} onSaved={() => {}} />)
    expect(screen.getByText('No attribution data yet.')).toBeInTheDocument()
  })

  it('mints a named source — POSTs the slug + calls onSaved', async () => {
    const f = okFetch()
    const onSaved = vi.fn()
    render(<VisitorsPanel data={REPORT} baseUrl={BASE} onSaved={onSaved} />)
    fireEvent.change(screen.getByTestId('visitors-mint-slug'), { target: { value: 'linkedin_profile' } })
    fireEvent.click(screen.getByTestId('visitors-mint-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${BASE}/api/admin/attribution`)
    expect(JSON.parse(init.body)).toEqual({ action: 'mint', slug: 'linkedin_profile' })
  })

  it('disables Add for an invalid slug', () => {
    render(<VisitorsPanel data={REPORT} baseUrl={BASE} onSaved={() => {}} />)
    const submit = screen.getByTestId('visitors-mint-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true) // empty
    fireEvent.change(screen.getByTestId('visitors-mint-slug'), { target: { value: 'bad slug!' } })
    expect(submit.disabled).toBe(true) // still invalid (lowercased to "bad slug!")
  })

  it('an owner source exposes copy / résumé-PDF / retire; outreach exposes none', () => {
    const data = {
      ...REPORT,
      links: [link({ code: 'my_src', artifactType: 'owner_source', company: null, recipient: null }), link({})],
    }
    render(<VisitorsPanel data={data} baseUrl={BASE} onSaved={() => {}} />)
    expect(screen.getByTestId('visitors-copy-my_src')).toBeInTheDocument()
    expect(screen.getByTestId('visitors-retire-my_src')).toBeInTheDocument()
    const dl = screen.getByTestId('visitors-download-my_src') as HTMLAnchorElement
    expect(dl).toHaveAttribute('href', `${BASE}/api/admin/attribution/my_src/resume.pdf`)
    // outreach is opaque + per-recipient → no broadcast actions
    expect(screen.queryByTestId('visitors-copy-out1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('visitors-retire-out1')).not.toBeInTheDocument()
  })

  it('copies the transparent ?from= link to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const data = { ...REPORT, links: [link({ code: 'my_src', artifactType: 'owner_source' })] }
    render(<VisitorsPanel data={data} baseUrl={BASE} onSaved={() => {}} />)
    fireEvent.click(screen.getByTestId('visitors-copy-my_src'))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?from=my_src`)
  })

  it('retires an owner source — POSTs retire + calls onSaved', async () => {
    const f = okFetch()
    const onSaved = vi.fn()
    const data = { ...REPORT, links: [link({ code: 'gone', artifactType: 'owner_source' })] }
    render(<VisitorsPanel data={data} baseUrl={BASE} onSaved={onSaved} />)
    fireEvent.click(screen.getByTestId('visitors-retire-gone'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ action: 'retire', slug: 'gone' })
  })

  it('shows a retired badge + hides actions for a soft-retired source', () => {
    const data = {
      ...REPORT,
      links: [link({ code: 'old', artifactType: 'owner_source', expiresAt: '2020-01-01T00:00:00Z' })],
    }
    render(<VisitorsPanel data={data} baseUrl={BASE} onSaved={() => {}} />)
    expect(screen.getByTestId('visitors-retired-old')).toBeInTheDocument()
    expect(screen.queryByTestId('visitors-retire-old')).not.toBeInTheDocument()
    expect(screen.queryByTestId('visitors-copy-old')).not.toBeInTheDocument()
  })

  it('sorts the links table by Clicks on header click (desc-first)', () => {
    const many: AdminAttributionReport = {
      ...REPORT,
      links: [
        link({ code: 'a', company: 'Acorn', clicks: 1, uniqueVisitors: 1 }),
        link({ code: 'b', company: 'Bolt', clicks: 9, uniqueVisitors: 5 }),
      ],
    }
    render(<VisitorsPanel data={many} baseUrl={BASE} onSaved={() => {}} />)
    const linkOrder = () =>
      screen
        .getAllByRole('row')
        .map((r) => r.textContent ?? '')
        .filter((t) => /Acorn|Bolt/.test(t))
        .map((t) => (/Bolt/.test(t) ? 'Bolt' : 'Acorn'))
    expect(linkOrder()).toEqual(['Acorn', 'Bolt'])
    fireEvent.click(screen.getByTestId('datatable-sort-clicks'))
    expect(linkOrder()).toEqual(['Bolt', 'Acorn'])
  })
})
