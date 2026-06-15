import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import * as React from 'react'

/** Brand wordmark — the candidate's name, baked at build time (placeholder default). */
const BRAND_NAME = (import.meta.env.VITE_PERSON_NAME as string | undefined) ?? 'Jane Doe'

const LINKS: { to: string; label: string }[] = [
  { to: '/live', label: 'Live' },
  { to: '/pipeline', label: 'Job Pipeline' },
  { to: '/architecture', label: 'Architecture' },
  { to: '/simulator', label: 'Watch it work' },
  { to: '/work', label: 'Work' },
  { to: '/contact', label: 'Contact' },
]

/**
 * Slim site nav (PORTAL §8.1 / §13), shared by the marketing pages (`/`, `/work`)
 * and the ops pages (`/pipeline`, `/architecture`, `/live`). Order = lead with the
 * wow (`/live`), cluster its drill-ins (`Job Pipeline`, `Architecture`), then the
 * personal/conversion tail (`Watch it work` → the "watch me apply to your role"
 * spoke at `/simulator`, `Work`, `Contact`). "Job Pipeline" is the
 * visitor label for the funnel page (`/pipeline`, §24.59); the internal naming
 * stays "funnel". `/about` is a footer link (§8.2), not a header item. Brand
 * wordmark = the candidate's name (not a domain — on a personal hiring portal the
 * candidate IS the brand). Per-deployment build-time env (STRATEGY §24.71 9.4b-3,
 * the planned `VITE_PERSON_NAME`); the committed default is the generic placeholder.
 *
 * Responsive (§13): the horizontal row overflows a phone, so below `sm` it
 * collapses to a hamburger disclosure menu (the full row fits ≥640px, so tablets
 * keep it). The menu is a labeled disclosure (`aria-expanded` / `aria-controls`)
 * that closes on Escape / outside-click / link-tap; every menu link is a ≥44px
 * tap target.
 */
export function SiteHeader() {
  const [open, setOpen] = React.useState(false)
  const linkClass = 'text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground'

  // Close the menu on Escape or an outside click while it's open. The outside
  // click listener is attached on the NEXT tick (setTimeout 0) so the very click
  // that opened the menu can't reach it — without the defer, toggling the icon
  // (Menu→X) detaches the clicked node, `closest()` on the detached target reads
  // as "outside", and the menu slams shut on its own opening click.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest('[data-site-header]')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const armClick = window.setTimeout(() => window.addEventListener('click', onClick), 0)
    return () => {
      window.clearTimeout(armClick)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
    }
  }, [open])

  return (
    <header data-site-header className="sticky top-0 z-20 w-full border-b border-border bg-background/80 backdrop-blur">
      <nav aria-label="Primary" className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
        <Link to="/" className="font-mono text-sm font-semibold tracking-tight text-foreground">
          {BRAND_NAME}
        </Link>

        {/* Tablet + desktop: the full horizontal row (≥640px, where it fits). */}
        <div className="hidden items-center gap-6 text-sm sm:flex">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} className={linkClass}>
              {l.label}
            </Link>
          ))}
        </div>

        {/* Phone: a hamburger toggling the disclosure menu below. */}
        <button
          type="button"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="site-menu"
          data-testid="nav-hamburger"
          onClick={() => setOpen((v) => !v)}
          className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
        >
          {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
        </button>
      </nav>

      {/* Phone menu (a disclosure, absolutely placed so it overlays content rather
          than pushing it). Hidden ≥640px regardless of `open`. */}
      {open ? (
        <div
          id="site-menu"
          data-testid="nav-menu"
          className="absolute inset-x-0 top-full border-b border-border bg-background shadow-lg sm:hidden"
        >
          <ul className="mx-auto flex max-w-3xl flex-col px-4 py-1">
            {LINKS.map((l) => (
              <li key={l.to}>
                <Link
                  to={l.to}
                  onClick={() => setOpen(false)}
                  className={`block rounded-md px-2 py-3 text-base ${linkClass}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </header>
  )
}
