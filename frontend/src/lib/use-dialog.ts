import * as React from 'react'

// The tabbable set inside a dialog. `[tabindex="-1"]` is excluded — those are
// programmatically focusable (like the panel shell) but not in the Tab order.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/**
 * The shared modal-dialog a11y contract (PORTAL §8.5), consumed by the
 * /momentum drawer (DetailPanel) and the /architecture node modal (NodePanel).
 * When `open`, it:
 *  - records the trigger (the previously focused element) and restores focus to
 *    it on close — the visitor lands back on the card/node they opened, not at
 *    the top of the page;
 *  - moves focus into the panel;
 *  - traps Tab / Shift+Tab within the panel (the WAI-ARIA APG modal pattern —
 *    focus can't escape to the page behind);
 *  - closes on Escape;
 *  - marks every off-path sibling from the overlay up to <body> `inert`, so
 *    assistive tech + pointer can't reach the backdrop content. No portal: the
 *    walk leaves the React/DOM tree intact, so NodePanel's `layoutId`
 *    grow-from-node transition is untouched (`inert` doesn't affect layout or
 *    visibility, only interactivity + the a11y tree).
 *
 * `panelRef` is the focusable dialog surface (`tabIndex={-1}`, `role="dialog"`);
 * `overlayRef` is the outermost fixed overlay (the inert walk starts there).
 */
export function useDialog<P extends HTMLElement, O extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<P | null>,
  overlayRef: React.RefObject<O | null>,
): void {
  // Latest onClose without re-running the effect (and re-trapping) every render.
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  React.useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const overlay = overlayRef.current
    const trigger = document.activeElement as HTMLElement | null

    // Move focus into the dialog (the panel shell is tabIndex=-1).
    panel?.focus()

    // Inert everything outside the overlay: walk from the overlay up to <body>,
    // marking each off-path sibling. We track only what we set so cleanup
    // restores the page exactly — a pre-existing `inert` is left as-is.
    const inerted: HTMLElement[] = []
    let node: HTMLElement | null = overlay
    while (node && node.parentElement) {
      const parent = node.parentElement
      for (const sib of Array.from(parent.children)) {
        if (sib !== node && sib instanceof HTMLElement && !sib.hasAttribute('inert')) {
          sib.setAttribute('inert', '')
          inerted.push(sib)
        }
      }
      node = parent === document.body ? null : parent
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const focusables = focusablesIn(panel)
      if (focusables.length === 0) {
        // Nothing tabbable inside — keep focus pinned to the panel shell.
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const within = panel.contains(active)
      if (e.shiftKey) {
        // Going backward off the top (or from the shell / from outside) wraps to
        // the end.
        if (active === first || active === panel || !within) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !within) {
        // Going forward off the end (or from outside) wraps to the start.
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      for (const el of inerted) el.removeAttribute('inert')
      if (trigger && document.contains(trigger) && typeof trigger.focus === 'function') trigger.focus()
    }
  }, [open, panelRef, overlayRef])
}
