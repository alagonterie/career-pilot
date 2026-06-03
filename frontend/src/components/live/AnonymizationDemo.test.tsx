import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SanitizeDemoState } from '~/lib/use-sanitize-demo'

import { AnonymizationDemo } from './AnonymizationDemo'

function state(over: Partial<SanitizeDemoState> = {}): SanitizeDemoState {
  return {
    data: { raw: 'Email a@b.com', sanitized: 'Email [EMAIL_REDACTED]', redactions: 1, sample: 0, total: 3 },
    status: 'ok',
    showAnother: vi.fn(),
    ...over,
  }
}

describe('AnonymizationDemo (PORTAL §5.2)', () => {
  it('renders both panes, the redaction count, and the synthetic-only label', () => {
    render(<AnonymizationDemo state={state()} />)
    expect(screen.getByTestId('anon-raw')).toHaveTextContent('a@b.com')
    expect(screen.getByTestId('anon-sanitized')).toHaveTextContent('[EMAIL_REDACTED]')
    expect(screen.getByTestId('anon-count')).toHaveTextContent('1 redaction')
    expect(screen.getByTestId('anon-index')).toHaveTextContent('1 / 3')
    expect(screen.getByText(/synthetic only/i)).toBeInTheDocument()
  })

  it('invokes showAnother when the button is clicked', () => {
    const showAnother = vi.fn()
    render(<AnonymizationDemo state={state({ showAnother })} />)
    fireEvent.click(screen.getByTestId('anon-another'))
    expect(showAnother).toHaveBeenCalledTimes(1)
  })

  it('shows an honest error state when the demo is unavailable', () => {
    render(<AnonymizationDemo state={state({ data: null, status: 'error' })} />)
    expect(screen.getByTestId('anon-error')).toBeInTheDocument()
  })
})
