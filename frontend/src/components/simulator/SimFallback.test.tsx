import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Isolate the component from the router — its CTAs use <Link>, which would need
// a RouterProvider. A plain anchor stand-in lets us assert the rendered content.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

import { SimFallback } from './SimFallback'

afterEach(() => vi.restoreAllMocks())

describe('SimFallback (PORTAL §5.3 disabled state)', () => {
  it('shows the unavailable message + Talk to me, and lists recent runs as metrics only (§24.162)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              runs: [{ ts: new Date().toISOString(), total_cost_cents: 84, total_latency_ms: 152700 }],
            }),
          }) as Response,
      ),
    )
    render(<SimFallback kind="unavailable" onReset={() => {}} />)

    expect(screen.getByTestId('sim-unavailable')).toBeInTheDocument()
    expect(screen.getByText(/talk to me/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('sim-recent')).toBeInTheDocument())
    // Metrics render (cost + runtime); no visitor company/role text is present.
    expect(screen.getByText(/\$0\.84/)).toBeInTheDocument()
    expect(screen.getByText(/2m 33s/)).toBeInTheDocument()
  })

  it('brands the budget cap (§24.150) with the dashboard + architecture CTAs', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    )
    render(<SimFallback kind="unavailable" reason="budget" onReset={() => {}} />)

    expect(screen.getByTestId('sim-unavailable')).toBeInTheDocument()
    expect(screen.getByText(/busy today/i)).toBeInTheDocument()
    expect(screen.getByText(/see where it went/i)).toBeInTheDocument()
    expect(screen.getByText(/watch it throttle/i)).toBeInTheDocument()
    expect(screen.getByText(/talk to me/i)).toBeInTheDocument()
  })

  it('brands the per-IP cap (§24.150) with the pipeline CTA + the conversion path', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    )
    render(<SimFallback kind="unavailable" reason="rate_limit" onReset={() => {}} />)

    expect(screen.getByText(/used today/i)).toBeInTheDocument()
    expect(screen.getByText(/see the real pipeline/i)).toBeInTheDocument()
    expect(screen.getByText(/talk to me/i)).toBeInTheDocument()
  })

  it('brands the paused kill switch (§24.150) with pipeline + system-map CTAs', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    )
    render(<SimFallback kind="unavailable" reason="disabled" onReset={() => {}} />)

    expect(screen.getByText(/sandbox is paused/i)).toBeInTheDocument()
    // Exact CTA text (the body also mentions "the system map", so a substring
    // regex would match both).
    expect(screen.getByText('See the pipeline →')).toBeInTheDocument()
    expect(screen.getByText('System map →')).toBeInTheDocument()
  })

  it('renders an error variant with the message + a Try again action', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    )
    render(<SimFallback kind="error" message="The run stream dropped." onReset={() => {}} />)

    expect(screen.getByTestId('sim-error')).toBeInTheDocument()
    expect(screen.getByText('The run stream dropped.')).toBeInTheDocument()
    expect(screen.getByText(/try again/i)).toBeInTheDocument()
  })
})
