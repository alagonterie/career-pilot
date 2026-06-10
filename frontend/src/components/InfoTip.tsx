import * as React from 'react'
import { createPortal } from 'react-dom'

/**
 * A tap/click disclosure for metric jargon (PORTAL §5.2 / STRATEGY §24.57):
 * the mobile-capable replacement for desktop-only `title` attributes on the
 * ops register's vocabulary (`spend · est`, cache rate, p50/p95, the turn
 * seal). A small ⓘ trigger toggles a short explainer panel.
 *
 * Deliberately a disclosure, not a dialog: no focus trap, no inert backdrop —
 * it closes on Esc, outside-tap, re-tap, or scroll (the standard tooltip
 * contract). The panel renders through a portal at a fixed position so it
 * can't be clipped by `overflow` ancestors (the LogStream scroll area).
 * Keyboard: the trigger is a real button (Enter/Space toggle). No animation —
 * trivially reduced-motion-safe.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const id = React.useId()

  const PANEL_W = 256 // w-64 — used to clamp the centered panel inside the viewport
  const openTip = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const half = PANEL_W / 2 + 8
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
      <button
        ref={btnRef}
        type="button"
        data-testid="info-tip-trigger"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`About: ${label}`}
        onClick={() => (open ? setOpen(false) : openTip())}
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 align-middle font-sans text-[9px] leading-none text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        i
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              role="note"
              data-testid="info-tip-panel"
              style={{ top: pos.top, left: pos.left }}
              className="fixed z-50 w-64 -translate-x-1/2 rounded-md border border-border bg-card p-3 text-left font-sans text-xs font-normal normal-case leading-relaxed tracking-normal text-muted-foreground shadow-lg"
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
