import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AdminPersona } from '~/lib/use-admin'

import { PersonaPanel } from './PersonaPanel'

const DATA: AdminPersona = {
  fields: {
    full_name: 'Jane Doe',
    display_name: 'Jane',
    bio: 'Engineer',
    target_roles: JSON.stringify(['Staff Eng', 'Infra Lead']),
    skills: JSON.stringify(['Go', 'Postgres']),
    location_pref: '{"remote":true}',
    comp_floor: 185000,
    search_goals: 'Find a staff role',
    master_resume: 'resume text',
    github_url: 'https://github.com/janedoe',
    linkedin_url: null,
    x_url: null,
    website_url: null,
    public_email: 'jane@example.com',
    brand_color_hsl: '210 80% 50%',
    headshot_path: null,
    protected_terms: JSON.stringify(['Acme']),
    gmail_account: 'jane@gmail.com',
  },
  readonlyFields: ['gmail_account'],
  workProfile: { json: '{"name":"Jane Doe"}', source: 'manual', generated_at: '2026-06-24T00:00:00.000Z' },
  personaPreview: '# Jane Doe\n\nStaff engineer persona.',
  blockers: ['comp_floor'],
}

describe('PersonaPanel', () => {
  it('renders fields (arrays comma-joined), work-profile provenance, blockers, and the preview', () => {
    render(<PersonaPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.getByDisplayValue('Jane Doe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Staff Eng, Infra Lead')).toBeInTheDocument() // array shown comma-joined
    expect(screen.getByText('manual')).toBeInTheDocument() // honest work-profile provenance
    expect(screen.getByTestId('persona-blockers')).toHaveTextContent('comp_floor')
    expect(screen.getByTestId('persona-preview')).toHaveTextContent('Staff engineer persona')
  })

  it('marks gmail_account read-only', () => {
    render(<PersonaPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    const gmail = within(screen.getByTestId('persona-field-gmail_account')).getByRole('textbox')
    expect(gmail).toHaveAttribute('readonly')
  })

  it('reveals a Save button only once a field is edited', () => {
    render(<PersonaPanel data={DATA} baseUrl="http://x" onSaved={vi.fn()} />)
    expect(screen.queryByTestId('persona-save-full_name')).not.toBeInTheDocument()
    const input = within(screen.getByTestId('persona-field-full_name')).getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Jane Q. Doe' } })
    expect(screen.getByTestId('persona-save-full_name')).toBeInTheDocument()
  })
})
