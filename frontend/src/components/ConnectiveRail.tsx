import { Link, useLocation } from '@tanstack/react-router'

import { REPO_URL } from '~/lib/site'

type Surface = '/' | '/live' | '/architecture' | '/pipeline' | '/work'
type RailKind = 'convert' | 'deepen' | 'pivot'

type RailItem =
  | { label: string; kind: RailKind; to: '/contact' | '/live' | '/architecture' | '/pipeline' | '/work' | '/simulator' }
  | { label: string; kind: RailKind; href: string }

interface RailCfg {
  register: 'marketing' | 'ops'
  items: RailItem[]
}

// Per-surface "what's next" (PORTAL §8.4). The convert path is the constant; the
// /simulator-pointing pivots landed in 8.2 with that route. /contact (the sink),
// /simulator (its own results CTAs are the next step), + any unmapped route
// render no rail.
const RAIL: Record<Surface, RailCfg> = {
  '/': {
    register: 'marketing',
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'See it work', kind: 'deepen', to: '/live' },
      { label: 'Try it', kind: 'pivot', to: '/simulator' },
    ],
  },
  '/live': {
    register: 'ops',
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'How it works', kind: 'deepen', to: '/architecture' },
      { label: 'Run it on your role', kind: 'pivot', to: '/simulator' },
    ],
  },
  '/architecture': {
    register: 'ops',
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'Read the code', kind: 'deepen', href: REPO_URL },
      { label: 'See it run', kind: 'pivot', to: '/live' },
    ],
  },
  '/pipeline': {
    register: 'ops',
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'Watch it live', kind: 'deepen', to: '/live' },
    ],
  },
  '/work': {
    register: 'marketing',
    items: [
      { label: 'Talk to me', kind: 'convert', to: '/contact' },
      { label: 'See the system', kind: 'deepen', to: '/live' },
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
 * deepen/pivot options are per-surface. Register-aware (clean in marketing,
 * dense/mono in ops), reduced-motion-safe. Self-determines its config from the
 * current path, so the register layouts render it unconditionally.
 */
export function ConnectiveRail() {
  const { pathname } = useLocation()
  const cfg = railConfigFor(pathname)
  if (!cfg) return null // /contact (the sink) + unmapped routes get no rail

  const from = fromParam(pathname)
  const ops = cfg.register === 'ops'

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
      className={[
        'mx-auto flex w-full flex-wrap items-center gap-x-4 gap-y-3 border-t border-border px-6',
        ops ? 'max-w-6xl py-5 font-mono text-xs' : 'max-w-3xl py-8 text-sm',
      ].join(' ')}
    >
      <span className={ops ? 'uppercase tracking-widest text-muted-foreground' : 'text-muted-foreground'}>
        What&apos;s next
      </span>
      <div className="flex flex-wrap items-center gap-2">
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
    </nav>
  )
}
