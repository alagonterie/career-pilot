import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { InfoTip } from './InfoTip'

function renderTip() {
  return render(
    <InfoTip label="spend · est">
      <p>An estimate, not a bill.</p>
    </InfoTip>,
  )
}

describe('InfoTip', () => {
  it('renders a labeled trigger, closed by default', () => {
    renderTip()
    const btn = screen.getByTestId('info-tip-trigger')
    expect(btn).toHaveAttribute('aria-label', 'About: spend · est')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('info-tip-panel')).not.toBeInTheDocument()
  })

  it('opens on click and associates the panel (aria-controls)', () => {
    renderTip()
    const btn = screen.getByTestId('info-tip-trigger')
    fireEvent.click(btn)
    const panel = screen.getByTestId('info-tip-panel')
    expect(panel).toHaveTextContent('An estimate, not a bill.')
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(btn).toHaveAttribute('aria-controls', panel.id)
  })

  it('closes on a second click (toggle)', () => {
    renderTip()
    const btn = screen.getByTestId('info-tip-trigger')
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(screen.queryByTestId('info-tip-panel')).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    renderTip()
    fireEvent.click(screen.getByTestId('info-tip-trigger'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('info-tip-panel')).not.toBeInTheDocument()
  })

  it('closes on an outside pointerdown, stays open on an inside one', () => {
    renderTip()
    fireEvent.click(screen.getByTestId('info-tip-trigger'))
    fireEvent.pointerDown(screen.getByTestId('info-tip-panel'))
    expect(screen.getByTestId('info-tip-panel')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('info-tip-panel')).not.toBeInTheDocument()
  })

  it('closes on scroll (the standard tooltip contract)', () => {
    renderTip()
    fireEvent.click(screen.getByTestId('info-tip-trigger'))
    fireEvent.scroll(window)
    expect(screen.queryByTestId('info-tip-panel')).not.toBeInTheDocument()
  })
})
