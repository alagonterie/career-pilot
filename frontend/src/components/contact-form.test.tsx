import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContactForm } from './ContactForm'

afterEach(() => {
  vi.unstubAllGlobals()
})

function fillValid(): void {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam Recruiter' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@acme.com' } })
  fireEvent.change(screen.getByLabelText('Role / title'), { target: { value: 'Staff Engineer' } })
  fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'We are hiring — let’s talk.' } })
}

describe('ContactForm (PORTAL §5.7)', () => {
  it('prefills company + role from carried context', () => {
    render(<ContactForm company="Acme Corp" role="Staff Engineer" />)
    expect(screen.getByLabelText('Company')).toHaveValue('Acme Corp')
    expect(screen.getByLabelText('Role / title')).toHaveValue('Staff Engineer')
  })

  it('blocks submit + shows validation errors when required fields are empty', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<ContactForm />)
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/your name is required/i)).toBeInTheDocument()
    expect(screen.getByText(/email is required/i)).toBeInTheDocument()
    expect(screen.getByText(/role \/ title is required/i)).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled() // never POSTs an invalid submission
  })

  it('shows the Sent confirmation on a successful relay', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response))
    render(<ContactForm />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByTestId('contact-sent')).toBeInTheDocument()
  })

  it('shows an honest error pointing to direct contact when the relay is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response))
    render(<ContactForm />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByTestId('contact-error')).toBeInTheDocument()
  })
})
