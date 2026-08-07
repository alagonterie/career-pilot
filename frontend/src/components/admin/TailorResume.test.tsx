import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TailoredRun } from '~/lib/use-admin'

import { TailorResume } from './TailorResume'

/**
 * §24.191. The behaviours worth locking down are the ones that cost real money
 * or real trust: the pending row must present as in-flight (so the owner doesn't
 * hammer Generate), a bio floored back to the master must be visible rather than
 * silent, and the JD box must be able to override the scraped description.
 */
function run(over: Partial<TailoredRun> = {}): TailoredRun {
  return {
    id: 'tr-1',
    lead_id: 'lead-1',
    created_at: '2026-08-07T12:00:00.000Z',
    completed_at: '2026-08-07T12:00:30.000Z',
    status: 'ready',
    jd_used: null,
    notes: null,
    bio_outcome: 'tailored',
    model: 'claude-sonnet-4-6',
    cost_cents: 6,
    error: null,
    source_slug: 'apply_globex',
    has_resume: true,
    ...over,
  }
}

function mockFetch(runs: TailoredRun[], post?: { ok: boolean; status?: number; error?: string }) {
  const calls: Array<{ url: string; body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (init?.method === 'POST') {
        const p = post ?? { ok: true, status: 202 }
        return Promise.resolve({
          ok: p.ok,
          status: p.status ?? (p.ok ? 202 : 409),
          json: () => Promise.resolve(p.error ? { error: p.error } : { ok: true }),
        } as Response)
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ runs }) } as Response)
    }),
  )
  return calls
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('TailorResume (§24.191)', () => {
  it('offers to tailor when the lead has no résumé yet', async () => {
    mockFetch([])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    expect(await screen.findByTestId('tailor-open')).toHaveTextContent('Tailor résumé')
    expect(screen.getByText('none yet')).toBeInTheDocument()
  })

  it('shows a download and the tailored-summary signal on a ready run', async () => {
    mockFetch([run()])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    const link = await screen.findByTestId('tailor-download')
    expect(link).toHaveAttribute('href', '/api/admin/tailored/tr-1/resume.pdf')
    expect(screen.getByTestId('tailor-bio-tailored')).toBeInTheDocument()
    // Regenerate, not "Tailor" — a version already exists.
    expect(screen.getByTestId('tailor-open')).toHaveTextContent('Regenerate')
  })

  it('flags a bio that fell back to the master rather than hiding it', async () => {
    mockFetch([run({ bio_outcome: 'fallback_unverified_number' })])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    expect(await screen.findByTestId('tailor-bio-fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('tailor-bio-tailored')).not.toBeInTheDocument()
  })

  it('hides the generate button while a run is pending, so it cannot be double-spent', async () => {
    mockFetch([run({ status: 'pending', completed_at: null, has_resume: false, bio_outcome: null })])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    expect(await screen.findByTestId('tailor-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('tailor-open')).not.toBeInTheDocument()
  })

  it('surfaces a failed run with its reason', async () => {
    mockFetch([run({ status: 'failed', has_resume: false, error: 'Experience at "Initech" is not in the master.' })])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    expect(await screen.findByTestId('tailor-failed')).toHaveTextContent('Initech')
  })

  it('posts the pasted JD, the note, and the attribution choice', async () => {
    const calls = mockFetch([])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    fireEvent.click(await screen.findByTestId('tailor-open'))
    fireEvent.change(screen.getByTestId('tailor-jd'), { target: { value: 'the real posting' } })
    fireEvent.change(screen.getByTestId('tailor-notes'), { target: { value: 'lean on platform work' } })
    fireEvent.click(screen.getByTestId('tailor-attribute'))
    fireEvent.click(screen.getByTestId('tailor-generate'))

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/tailor'))
      expect(post?.body).toEqual({ jd: 'the real posting', notes: 'lean on platform work', attribute: false })
    })
  })

  it('omits an empty JD so the server falls back to the scraped description', async () => {
    const calls = mockFetch([])
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    fireEvent.click(await screen.findByTestId('tailor-open'))
    fireEvent.click(screen.getByTestId('tailor-generate'))
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/tailor'))
      expect(post?.body).toEqual({ attribute: true })
    })
  })

  it('treats a 409 already_generating as "join the poll", not an error', async () => {
    mockFetch([], { ok: false, status: 409, error: 'already_generating' })
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    fireEvent.click(await screen.findByTestId('tailor-open'))
    fireEvent.click(screen.getByTestId('tailor-generate'))
    await waitFor(() => expect(screen.queryByTestId('tailor-error')).not.toBeInTheDocument())
  })

  it('explains a spend cap in plain language', async () => {
    mockFetch([], { ok: false, status: 429, error: 'daily_cap_reached' })
    render(<TailorResume leadId="lead-1" baseUrl="" />)
    fireEvent.click(await screen.findByTestId('tailor-open'))
    fireEvent.click(screen.getByTestId('tailor-generate'))
    expect(await screen.findByTestId('tailor-error')).toHaveTextContent("Today's tailoring cap is used up.")
  })
})
