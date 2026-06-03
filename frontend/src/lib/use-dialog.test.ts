import { fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useDialog } from './use-dialog'

// A minimal dialog that exercises the contract: a trigger + background sibling,
// and (when open) an overlay holding a tabIndex=-1 panel with two focusables.
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = React.useState(false)
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const close = (): void => {
    setOpen(false)
    onClose()
  }
  useDialog(open, close, panelRef, overlayRef)
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('button', { 'data-testid': 'trigger', onClick: () => setOpen(true) }, 'open'),
    React.createElement('div', { 'data-testid': 'bg' }, 'background'),
    open
      ? React.createElement(
          'div',
          { ref: overlayRef, 'data-testid': 'overlay' },
          React.createElement('button', { 'data-testid': 'backdrop' }, 'backdrop'),
          React.createElement(
            'div',
            { ref: panelRef, tabIndex: -1, role: 'dialog', 'data-testid': 'panel' },
            React.createElement('button', { 'data-testid': 'first' }, 'first'),
            React.createElement('button', { 'data-testid': 'last' }, 'last'),
          ),
        )
      : null,
  )
}

function openDialog() {
  const onClose = vi.fn()
  const utils = render(React.createElement(Harness, { onClose }))
  const trigger = utils.getByTestId('trigger') as HTMLButtonElement
  trigger.focus() // the trigger is the active element when the dialog opens
  fireEvent.click(trigger)
  return { onClose, trigger, ...utils }
}

describe('useDialog', () => {
  it('moves focus into the panel on open', () => {
    const { getByTestId } = openDialog()
    expect(document.activeElement).toBe(getByTestId('panel'))
  })

  it('traps Tab forward — wraps from the last focusable to the first', () => {
    const { getByTestId } = openDialog()
    getByTestId('last').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(getByTestId('first'))
  })

  it('traps Shift+Tab backward — wraps from the first focusable to the last', () => {
    const { getByTestId } = openDialog()
    getByTestId('first').focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(getByTestId('last'))
  })

  it('closes on Escape', () => {
    const { onClose } = openDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('holds the rest of the page inert while open and clears it on close', () => {
    const { getByTestId, queryByTestId } = openDialog()
    expect(getByTestId('bg')).toHaveAttribute('inert')
    expect(getByTestId('trigger')).toHaveAttribute('inert')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(queryByTestId('overlay')).not.toBeInTheDocument()
    expect(getByTestId('bg')).not.toHaveAttribute('inert')
  })

  it('restores focus to the trigger on close', () => {
    const { getByTestId } = openDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(getByTestId('trigger'))
  })
})
