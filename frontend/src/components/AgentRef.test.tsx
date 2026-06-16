import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentRef } from './AgentRef'

describe('AgentRef (§24.73)', () => {
  it('renders the actor handle as a trigger, popover closed by default', () => {
    render(<AgentRef name="tailor-resume" />)
    const btn = screen.getByTestId('agent-ref')
    expect(btn).toHaveTextContent('tailor-resume')
    expect(btn).toHaveAttribute('data-actor', 'tailor-resume')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('agent-ref-panel')).not.toBeInTheDocument()
  })

  it('opens an explainer with the role, blurb, and access badge', () => {
    render(<AgentRef name="tailor-resume" />)
    fireEvent.click(screen.getByTestId('agent-ref'))
    const panel = screen.getByTestId('agent-ref-panel')
    expect(panel).toHaveTextContent('Résumé tailor')
    expect(panel).toHaveTextContent('Tailors my master résumé')
    expect(panel).toHaveTextContent('changes nothing')
  })

  it('resolves a host actor (via alias) and notes the system runs it (in the aria-label)', () => {
    render(<AgentRef name="win-confidence" />)
    const btn = screen.getByTestId('agent-ref')
    expect(btn).toHaveAttribute('data-actor', 'win-confidence-scorer')
    expect(btn).toHaveAttribute('aria-label', expect.stringContaining('the system runs on its own'))
  })

  it('closes on Escape', () => {
    render(<AgentRef name="draft-outreach" />)
    fireEvent.click(screen.getByTestId('agent-ref'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('agent-ref-panel')).not.toBeInTheDocument()
  })

  it('falls back to plain text for an unknown name — never a false chip', () => {
    render(<AgentRef name="mystery-tool" />)
    expect(screen.queryByTestId('agent-ref')).not.toBeInTheDocument()
    expect(screen.getByText('mystery-tool')).toBeInTheDocument()
  })
})
