import * as React from 'react'
import { createPortal } from 'react-dom'

import { cn } from '~/lib/utils'

/**
 * The site's one tap/click disclosure mechanism (§24.73): a trigger that toggles
 * a short explainer panel. Factored out of `InfoTip` so the ⓘ metric-jargon tip
 * and the `AgentRef` cast chip share ONE interaction contract instead of two —
 * a deliberate disclosure, not a dialog (no focus trap, no inert backdrop). It
 * closes on Esc, outside-tap, re-tap, or scroll (the standard tooltip contract),
 * and the panel renders through a portal at a fixed position so an `overflow`
 * ancestor (the LogStream scroll area, a card) can't clip it. The trigger is a
 * real button (Enter/Space toggle); no animation — reduced-motion-safe.
 *
 * The trigger is a render-prop so each caller owns its look (a tiny ⓘ pill vs.
 * an inline agent name) while the open/position/dismiss logic stays shared.
 */

export interface DisclosureTriggerProps {
  ref: React.Ref<HTMLButtonElement>
  'aria-expanded': boolean
  'aria-controls': string | undefined
  'aria-label': string
  onClick: () => void
}

export function DisclosureTip({
  trigger,
  children,
  ariaLabel,
  panelTestId,
  panelRole = 'note',
  panelWidth = 256,
  panelClassName,
}: {
  trigger: (props: DisclosureTriggerProps) => React.ReactNode
  children: React.ReactNode
  ariaLabel: string
  panelTestId?: string
  panelRole?: React.AriaRole
  panelWidth?: number
  panelClassName?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const id = React.useId()

  const openTip = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const half = panelWidth / 2 + 8
    const center = Math.min(Math.max(r.left + r.width / 2, half), Math.max(half, window.innerWidth - half))
    setPos({ top: r.bottom + 6, left: center })
    setOpen(true)
  }

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = (): void => setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <>
      {trigger({
        ref: btnRef,
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-label': ariaLabel,
        onClick: () => (open ? setOpen(false) : openTip()),
      })}
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              role={panelRole}
              data-testid={panelTestId}
              style={{ top: pos.top, left: pos.left, width: panelWidth }}
              className={cn(
                'fixed z-50 -translate-x-1/2 rounded-md border border-border bg-card p-3 text-left font-sans text-xs font-normal normal-case leading-relaxed tracking-normal shadow-lg',
                panelClassName,
              )}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
