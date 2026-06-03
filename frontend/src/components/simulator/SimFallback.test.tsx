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
  it('shows the unavailable message + Talk to me, and lists recent runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({ runs: [{ id: 'r1', visitor_company: 'Globex', visitor_role: 'Staff Engineer' }] }),
          }) as Response,
      ),
    )
    render(<SimFallback kind="unavailable" onReset={() => {}} />)

    expect(screen.getByTestId('sim-unavailable')).toBeInTheDocument()
    expect(screen.getByText(/talk to me/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('sim-recent')).toBeInTheDocument())
    expect(screen.getByText(/Globex/)).toBeInTheDocument()
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
