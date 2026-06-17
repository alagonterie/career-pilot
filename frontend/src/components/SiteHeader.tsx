import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import * as React from 'react'

import { PERSON_NAME } from '~/lib/site'

type NavLink = { to: string; label: string }

// The owner's grouped nav (§24.77 D2): three intent clusters, each split from the
// next by a subtle vertical divider so the grouping reads without hard labels.
// Order + labels are the owner's exact ask:
//   APPLY    — the search in action:   My Job Pipeline · Watch it work
//   OBSERVE  — the system from inside:  Dashboard · Architecture
//   PERSONAL — the candidate:          Experience · Contact
const NAV_GROUPS: NavLink[][] = [
  [
    { to: '/pipeline', label: 'My Job Pipeline' },
    { to: '/watch', label: 'Watch it work' },
  ],
  [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/architecture', label: 'Architecture' },
  ],
  [
    { to: '/experience', label: 'Experience' },
    { to: '/contact', label: 'Contact' },
  ],
]

/**
 * Slim site nav (PORTAL §8.1 / §13), shared by the marketing pages (`/`,
 * `/experience`) and the ops pages (`/pipeline`, `/dashboard`, `/architecture`,
 * `/watch`). Three groups split by subtle dividers (§24.77 D2): APPLY (the search
 * in action), OBSERVE (the system from inside), and the PERSONAL tail. "My Job
 * Pipeline" is the visitor label for `/pipeline`; `/about` is a footer link
 * (§8.2), not a header item. Brand wordmark = the candidate's name (not a domain —
 * on a personal hiring portal the candidate IS the brand). Per-deployment
 * build-time env (`VITE_PERSON_NAME`, §24.71 9.4b-3); the committed default is the
 * generic placeholder.
 *
 * Responsive (§13): the horizontal row overflows a phone, so below `sm` it
 * collapses to a hamburger disclosure menu (the full row fits ≥640px, so tablets
 * keep it). The menu is a labeled disclosure (`aria-expanded` / `aria-controls`)
 * that closes on Escape / outside-click / link-tap; every menu link is a ≥44px
 * tap target.
 */
export function SiteHeader() {
  const [open, setOpen] = React.useState(false)
  // Active page (§24.82): the current link brightens to foreground AND gets an
  // accent underline so "you are here" reads at a glance across six items. The
  // underline is text-decoration (not a border), so inactive links reserve no
  // space and nothing shifts when the active link changes.
  const linkClass =
    'text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground [&.active]:underline [&.active]:decoration-accent-cool [&.active]:decoration-2 [&.active]:underline-offset-[6px]'

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
      {/* max-w-4xl (not 3xl) + a guaranteed gap so the wordmark and the dense
          6-link nav never crowd — a long real name (VITE_PERSON_NAME) overflowed
          the narrower box and pressed up against the first link. shrink-0 on both
          ends keeps either from compressing the other. */}
      <nav aria-label="Primary" className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-6 px-6">
        <Link to="/" className="shrink-0 font-mono text-sm font-semibold tracking-tight text-foreground">
          {PERSON_NAME}
        </Link>

        {/* Tablet + desktop: the full horizontal row (≥640px, where it fits). Each
            group is its own tight cluster (gap-4); the larger gap-6 around the
            dividers makes the three clusters read as clusters, not one long row. */}
        <div className="hidden shrink-0 items-center gap-6 text-sm sm:flex">
          {NAV_GROUPS.map((group, gi) => (
            <React.Fragment key={gi}>
              {gi > 0 ? <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" /> : null}
              <div className="flex items-center gap-4">
                {group.map((l) => (
                  <Link key={l.to} to={l.to} className={linkClass}>
                    {l.label}
                  </Link>
                ))}
              </div>
            </React.Fragment>
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
            {NAV_GROUPS.map((group, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 ? <li aria-hidden="true" className="my-1 border-t border-border" /> : null}
                {group.map((l) => (
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
              </React.Fragment>
            ))}
          </ul>
        </div>
      ) : null}
    </header>
  )
}
