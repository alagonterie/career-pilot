import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The form under enforcement with a solved token — the hook is stubbed so the
// single-use-token contract (§24.200 D2) is asserted without Cloudflare's script.
const turnstile = vi.hoisted(() => ({ reset: vi.fn() }))
vi.mock('~/lib/use-turnstile', () => ({
  useTurnstile: () => ({
    token: 'tok-1',
    enforce: true,
    widget: null,
    status: 'ready',
    hint: null,
    reset: turnstile.reset,
  }),
}))

import { ContactForm } from './ContactForm'

afterEach(() => {
  vi.unstubAllGlobals()
  turnstile.reset.mockClear()
})

function fillValid(): void {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam Recruiter' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@acme.com' } })
  fireEvent.change(screen.getByLabelText('Role / title'), { target: { value: 'Staff Engineer' } })
  fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'We are hiring — let’s talk.' } })
}

describe('ContactForm + Turnstile (§24.200)', () => {
  it('sends the token as the x-turnstile-token header and does not reset on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    render(<ContactForm />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await screen.findByTestId('contact-sent')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-turnstile-token']).toBe('tok-1')
    expect(turnstile.reset).not.toHaveBeenCalled()
  })

  it('names a verification failure on a 403 and solves a fresh token for the retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response))
    render(<ContactForm />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    const err = await screen.findByTestId('contact-error')
    expect(err).toHaveTextContent(/verify you’re human/i)
    expect(turnstile.reset).toHaveBeenCalledTimes(1)
  })

  it('resets the spent token after a non-verification failure too, keeping the relay copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response))
    render(<ContactForm />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    const err = await screen.findByTestId('contact-error')
    expect(err).toHaveTextContent(/footer/i)
    expect(turnstile.reset).toHaveBeenCalledTimes(1)
  })

  it('resets after a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    render(<ContactForm />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await screen.findByTestId('contact-error')
    expect(turnstile.reset).toHaveBeenCalledTimes(1)
  })
})
