import { Link, useRouterState } from '@tanstack/react-router'

import { CHROME_WIDTH, isMonoSurface, REPO_URL } from '~/lib/site'
import { cn } from '~/lib/utils'

type Surface = '/' | '/dashboard' | '/architecture' | '/pipeline' | '/experience' | '/about'
type RailKind = 'convert' | 'deepen' | 'pivot'

type RailItem =
  | { label: string; kind: RailKind; to: '/contact' | '/dashboard' | '/architecture' | '/pipeline' | '/watch' }
  | { label: string; kind: RailKind; href: string }

interface RailCfg {
  items: RailItem[]
}

// Per-surface "what's next" (PORTAL §8.4). The convert path is the constant; the
// /watch-pointing pivots landed in 8.2 with that route (§24.77: /simulator→/watch).
// /contact (the sink), /watch (its own results CTAs are the next step), + any
// unmapped route render no rail.
const RAIL: Record<Surface, RailCfg> = {
  '/': {
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'See it work', kind: 'deepen', to: '/dashboard' },
      { label: 'Watch me apply', kind: 'pivot', to: '/watch' },
    ],
  },
  '/dashboard': {
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'How it works', kind: 'deepen', to: '/architecture' },
      { label: 'Run it on your role', kind: 'pivot', to: '/watch' },
    ],
  },
  '/architecture': {
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'Read the code', kind: 'deepen', href: REPO_URL },
      { label: 'See it run', kind: 'pivot', to: '/dashboard' },
    ],
  },
  '/pipeline': {
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'See it run', kind: 'deepen', to: '/dashboard' },
    ],
  },
  '/experience': {
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'See the system', kind: 'deepen', to: '/dashboard' },
    ],
  },
  '/about': {
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'Read the code', kind: 'deepen', href: REPO_URL },
      { label: 'See it run', kind: 'pivot', to: '/dashboard' },
    ],
  },
}

function fromParam(pathname: string): string {
  return pathname === '/' ? 'home' : pathname.slice(1)
}

/** Pure: the rail config for a path (or null = no rail — the sink + unmapped
 * routes). Exported so the per-surface mapping is unit-testable without a
 * router context. */
export function railConfigFor(pathname: string): RailCfg | null {
  return (RAIL as Record<string, RailCfg | undefined>)[pathname] ?? null
}

/**
 * The connective rail (PORTAL §8.4): a slim "what's next" band at the foot of
 * every deep surface so none is a dead-end. The convert path (→ /contact, with
 * the originating surface as `?from`) is the constant + visually primary; the
 * deepen/pivot options are per-surface. One height everywhere; only the mono
 * surfaces (/dashboard, /architecture) wear the terminal treatment (mono font +
 * uppercase label). Reads the committed path, so it renders unconditionally in
 * both register layouts.
 */
export function ConnectiveRail() {
  // The committed (rendered) pathname, not the pending navigation target. Reading
  // `location` made the rail preview the next page's buttons/height before that page
  // rendered; `resolvedLocation` lags until the new route commits, so the rail
  // changes in step with the content.
  const pathname = useRouterState({
    select: (s) => s.resolvedLocation?.pathname ?? s.location.pathname,
  })
  const cfg = railConfigFor(pathname)
  if (!cfg) return null // /contact (the sink) + unmapped routes get no rail

  const from = fromParam(pathname)
  const mono = isMonoSurface(pathname)

  const itemClass = (kind: RailKind): string =>
    [
      'rounded-md border px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      kind === 'convert'
        ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
        : 'border-border text-muted-foreground hover:text-foreground',
    ].join(' ')

  return (
    <nav
      aria-label="What's next"
      data-testid="connective-rail"
      className={cn('w-full border-t border-border', mono && 'font-mono')}
    >
      <div
        className={cn(
          // Full-bleed border (chrome), content in the shared CHROME_WIDTH px-6 column
          // so the foot frames the page on the same gutter as the top (PORTAL §8.4).
          // One height everywhere (py-8 text-sm) — it's the conversion band, so give it
          // presence + comfortable tap targets. Centered wrap on a phone (the buttons
          // stack 2+1 there — left-aligned read as ragged overflow); left-aligned ≥sm.
          'mx-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-3 px-6 py-8 text-sm sm:justify-start',
          CHROME_WIDTH,
        )}
      >
        <span className={mono ? 'uppercase tracking-widest text-muted-foreground' : 'text-muted-foreground'}>
          What&apos;s next
        </span>
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          {cfg.items.map((it) => {
            if ('href' in it) {
              return (
                <a
                  key={it.label}
                  href={it.href}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`rail-${it.kind}`}
                  className={itemClass(it.kind)}
                >
                  {it.label} ↗
                </a>
              )
            }
            if (it.to === '/contact') {
              return (
                <Link
                  key={it.label}
                  to="/contact"
                  search={{ from }}
                  data-testid={`rail-${it.kind}`}
                  className={itemClass(it.kind)}
                >
                  {it.label} →
                </Link>
              )
            }
            return (
              <Link key={it.label} to={it.to} data-testid={`rail-${it.kind}`} className={itemClass(it.kind)}>
                {it.label} →
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
