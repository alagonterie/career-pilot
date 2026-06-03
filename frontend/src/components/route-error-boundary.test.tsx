import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RouteErrorBoundary } from './RouteErrorBoundary'

// The boundary takes only the TanStack `ErrorComponentProps` ({ error, reset })
// and uses no router context (Go home is a plain anchor), so it renders standalone.
describe('RouteErrorBoundary (§24.36 36.3)', () => {
  it('renders an on-brand, recoverable card for a thrown error', () => {
    render(<RouteErrorBoundary error={new Error('boom')} reset={() => {}} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/ran into a problem/i)).toBeInTheDocument()
    // Go home is an escape hatch to the root.
    expect(screen.getByRole('link', { name: /go home/i })).toHaveAttribute('href', '/')
  })

  it('resets the boundary when Try again is clicked', () => {
    const reset = vi.fn()
    render(<RouteErrorBoundary error={new Error('boom')} reset={reset} />)
    fireEvent.click(screen.getByTestId('route-error-retry'))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('shows the raw error only in dev (visitors never see a trace)', () => {
    // vitest runs in development mode → import.meta.env.DEV is true, so the
    // detail block renders + carries the message. The production build hides it
    // (asserted in architecture.spec.ts against the prod E2E build).
    render(<RouteErrorBoundary error={new Error('boom-detail')} reset={() => {}} />)
    expect(screen.getByTestId('route-error-detail')).toHaveTextContent('boom-detail')
  })
})
