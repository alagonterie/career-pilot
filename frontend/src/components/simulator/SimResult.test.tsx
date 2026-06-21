import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SimResult } from './SimResult'

// §24.146 — the two-gift results presentation. The cold email is now a structured
// emission (the `coldEmail` prop), preferred over parsing it out of the chat text.
describe('SimResult — structured cold-email gift (§24.146)', () => {
  const base = {
    runId: 'sb-test',
    company: 'Acme',
    role: 'Staff Engineer',
    trace: [],
    costUsd: 0.5,
    hasTailoredResume: true,
  }

  it('renders the cold-email gift from the structured coldEmail prop', () => {
    render(
      <SimResult
        {...base}
        outputText={'## Summary\n\nI build things.'}
        coldEmail={{
          subject: 'Your Staff Engineer role',
          body: 'Hi there, I would be a strong fit because I build resilient systems. Could we talk?',
        }}
      />,
    )
    expect(screen.getByTestId('sim-outreach')).toBeInTheDocument()
    expect(screen.getByText('Subject: Your Staff Engineer role')).toBeInTheDocument()
  })

  it('prefers the structured coldEmail over any email parsed from the chat text', () => {
    render(
      <SimResult
        {...base}
        outputText={'## Cold Outreach Email\n\n**Subject:** PARSED-FROM-TEXT\n\nHi there, legacy body.'}
        coldEmail={{
          subject: 'STRUCTURED-WINS',
          body: 'Hi there, this is the structured body that should render instead.',
        }}
      />,
    )
    expect(screen.getByText('Subject: STRUCTURED-WINS')).toBeInTheDocument()
    expect(screen.queryByText('Subject: PARSED-FROM-TEXT')).not.toBeInTheDocument()
  })

  it('falls back to parsing the chat text when no structured coldEmail is present (legacy runs)', () => {
    render(
      <SimResult
        {...base}
        outputText={'## Cold Outreach Email\n\n**Subject:** Legacy subject\n\nHi there, legacy body for an old run.'}
        coldEmail={null}
      />,
    )
    expect(screen.getByText('Subject: Legacy subject')).toBeInTheDocument()
  })
})
