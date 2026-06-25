import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AdminContact } from '~/lib/use-admin'

import { ContactsPanel } from './ContactsPanel'

function contact(over: Partial<AdminContact> & { id: string }): AdminContact {
  return {
    name: 'Sam Recruiter',
    email: 'sam@acme.example',
    company: 'Acme',
    role: 'Staff Eng',
    source: 'portal',
    message: 'Hello, we are hiring.',
    delivered: 1,
    createdAt: '2026-06-19T10:00:00Z',
    ...over,
  }
}

describe('ContactsPanel', () => {
  it('renders a contact row with the From email + the clamped message cell', () => {
    render(<ContactsPanel contacts={[contact({ id: 'c1' })]} />)
    const rowEl = screen.getByTestId('admin-contact-row')
    expect(rowEl).toHaveTextContent('sam@acme.example')
    const msg = screen.getByTestId('admin-contact-message')
    // the line-clamp is an inline style on the message cell (the load-bearing bit)
    expect(msg).toHaveStyle({ display: '-webkit-box' })
  })

  it('shows the empty note with no submissions', () => {
    render(<ContactsPanel contacts={[]} />)
    expect(screen.getByText('No inbound contact submissions yet.')).toBeInTheDocument()
  })
})
