import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentMark } from './AgentMark'

describe('AgentMark (§24.73)', () => {
  it('renders the ✦ marker with lead, an explainable AgentRef, and trail', () => {
    render(<AgentMark actor="tailor-resume" lead="Tailored by" trail="· hire.example.com" />)
    const mark = screen.getByTestId('agent-mark')
    expect(mark).toHaveAttribute('data-actor', 'tailor-resume')
    expect(mark).toHaveTextContent('✦')
    expect(mark).toHaveTextContent('Tailored by')
    expect(mark).toHaveTextContent('· hire.example.com')
    // The author is the explainable cast chip, not a bare string.
    expect(screen.getByTestId('agent-ref')).toHaveTextContent('tailor-resume')
  })

  it('attributes host-authored content to the host actor (no false subagent)', () => {
    render(<AgentMark actor="win-confidence-scorer" lead="Scored by" />)
    fireEvent.click(screen.getByTestId('agent-ref'))
    expect(screen.getByTestId('agent-ref-panel')).toHaveTextContent('runs on its own')
  })
})
