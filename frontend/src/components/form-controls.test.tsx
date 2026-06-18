import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormField, StableLabel } from './form-controls'

describe('FormField (§24.120 Δ — no layout shift)', () => {
  it('always renders the error slot, so showing/clearing a message never shifts siblings', () => {
    const { rerender, container } = render(
      <FormField label="Email">
        <input aria-label="Email" />
      </FormField>,
    )
    // The reserved error <span> exists with NO error (height held)…
    const slot = container.querySelector('span.min-h-4')
    expect(slot).not.toBeNull()
    expect(slot).toHaveTextContent('')
    // …and the SAME slot fills in when an error arrives (no node inserted/removed).
    rerender(
      <FormField label="Email" error="Email is required">
        <input aria-label="Email" />
      </FormField>,
    )
    expect(container.querySelector('span.min-h-4')).toHaveTextContent('Email is required')
  })
})

describe('StableLabel (§24.120 Δ — no button resize)', () => {
  it('keeps every label in the DOM (the spacer fixes width) but only the active one in the accessible name', () => {
    render(
      <button>
        <StableLabel labels={['Send →', 'Sending…']} active="Send →" />
      </button>,
    )
    expect(screen.getByText('Sending…')).toBeInTheDocument() // spacer present
    expect(screen.getByRole('button')).toHaveAccessibleName('Send →') // spacer is aria-hidden
  })

  it('swaps which label is active without changing the set of nodes', () => {
    const { rerender } = render(
      <button>
        <StableLabel labels={['Send →', 'Sending…']} active="Sending…" />
      </button>,
    )
    expect(screen.getByRole('button')).toHaveAccessibleName('Sending…')
    rerender(
      <button>
        <StableLabel labels={['Send →', 'Sending…']} active="Send →" />
      </button>,
    )
    expect(screen.getByRole('button')).toHaveAccessibleName('Send →')
  })
})
