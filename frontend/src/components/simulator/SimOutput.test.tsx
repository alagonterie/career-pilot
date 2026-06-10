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

  it('renders --- as a rule, not a paragraph (§24.31 Δ)', () => {
    const { container } = render(<SimOutput text={'## Bullets\n- one\n\n---\n\n## Outreach\nHi'} />)
    expect(container.querySelector('hr')).toBeInTheDocument()
    expect(screen.queryByText('---')).not.toBeInTheDocument()
  })

  it('renders **bold** and `code` inline instead of raw markers', () => {
    render(<SimOutput text={'**Subject:** Senior Engineer — `analyze_jd` approved'} />)
    const strong = screen.getByText('Subject:')
    expect(strong.tagName).toBe('STRONG')
    const code = screen.getByText('analyze_jd')
    expect(code.tagName).toBe('CODE')
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument()
  })

  it('renders ### as a subheading level below ##', () => {
    render(<SimOutput text={'## Section\n### Sub-point\nbody'} />)
    expect(screen.getByText('Section').tagName).toBe('H3')
    expect(screen.getByText('Sub-point').tagName).toBe('H4')
  })
})
