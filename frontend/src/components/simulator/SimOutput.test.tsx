import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SimOutput } from './SimOutput'

describe('SimOutput (PORTAL §5.3 result pane)', () => {
  it('renders the agent’s own ## sections + list items from the streamed text', () => {
    render(<SimOutput text={'## Tailored resume\n- shipped a pipeline\n\n## Cold outreach\nHi there'} />)
    expect(screen.getByText('Tailored resume')).toBeInTheDocument()
    expect(screen.getByText('shipped a pipeline')).toBeInTheDocument()
    expect(screen.getByText('Cold outreach')).toBeInTheDocument()
    expect(screen.getByText('Hi there')).toBeInTheDocument()
  })

  it('shows a skeleton while pending with no text yet', () => {
    render(<SimOutput text="" pending />)
    expect(screen.getByTestId('sim-output-skeleton')).toBeInTheDocument()
  })

  it('shows an empty state when not pending and there is no text', () => {
    render(<SimOutput text="" />)
    expect(screen.getByTestId('sim-output-empty')).toBeInTheDocument()
  })
})
