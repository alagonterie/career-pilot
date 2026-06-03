import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SimInput } from './SimInput'

describe('SimInput (PORTAL §5.3 input view)', () => {
  it('blocks submit + shows errors when company/role are empty', async () => {
    const onRun = vi.fn()
    render(<SimInput onRun={onRun} />)
    fireEvent.click(screen.getByRole('button', { name: /run simulation/i }))
    expect(await screen.findByText(/company is required/i)).toBeInTheDocument()
    expect(screen.getByText(/role \/ title is required/i)).toBeInTheDocument()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('calls onRun with the entered company + role (JD/URL omitted when blank)', async () => {
    const onRun = vi.fn()
    render(<SimInput onRun={onRun} />)
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme Corp' } })
    fireEvent.change(screen.getByLabelText('Role / title'), { target: { value: 'Staff Engineer' } })
    fireEvent.click(screen.getByRole('button', { name: /run simulation/i }))
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
    expect(onRun.mock.calls[0][0]).toMatchObject({ company: 'Acme Corp', role: 'Staff Engineer' })
    expect(onRun.mock.calls[0][0].jd).toBeUndefined()
  })
})
