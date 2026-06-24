import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { SimInput } from './SimInput'

// SimInput links to /privacy via <Link> (§24.164); stub the router so the form
// renders without a route tree.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, ...props }: { children: ReactNode; to?: string }) => <a {...props}>{children}</a>,
}))

describe('SimInput (PORTAL §5.3 input view)', () => {
  it('blocks submit + shows errors when company/role are empty', async () => {
    const onRun = vi.fn()
    render(<SimInput onRun={onRun} />)
    fireEvent.click(screen.getByRole('button', { name: /watch me apply/i }))
    expect(await screen.findByText(/enter a real company name/i)).toBeInTheDocument()
    expect(screen.getByText(/enter a real role or title/i)).toBeInTheDocument()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('blocks submit on obvious garbage input (single repeated char), inline error (§24.104)', async () => {
    const onRun = vi.fn()
    render(<SimInput onRun={onRun} />)
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'xxxx' } })
    fireEvent.change(screen.getByLabelText('Role / title'), { target: { value: '....' } })
    fireEvent.click(screen.getByRole('button', { name: /watch me apply/i }))
    expect(await screen.findByText(/enter a real company name/i)).toBeInTheDocument()
    expect(screen.getByText(/enter a real role or title/i)).toBeInTheDocument()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('calls onRun with the entered company + role (JD/URL omitted when blank)', async () => {
    const onRun = vi.fn()
    render(<SimInput onRun={onRun} />)
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme Corp' } })
    fireEvent.change(screen.getByLabelText('Role / title'), { target: { value: 'Staff Engineer' } })
    fireEvent.click(screen.getByRole('button', { name: /watch me apply/i }))
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
    expect(onRun.mock.calls[0][0]).toMatchObject({ company: 'Acme Corp', role: 'Staff Engineer' })
    expect(onRun.mock.calls[0][0].jd).toBeUndefined()
  })
})
