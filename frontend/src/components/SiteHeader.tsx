import { Link } from '@tanstack/react-router'

/**
 * Slim marketing-register nav (PORTAL §8.1), shared by `/` and `/work`. A plain
 * shared component for now; promote to a `(marketing)` route-group layout when
 * `/contact` lands. Brand wordmark = the persona name (not a domain — the
 * deployed site is `hire.<DOMAIN>`); links right.
 */
export function SiteHeader() {
  const linkClass =
    'text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground'
  return (
    <header className="sticky top-0 z-10 w-full border-b border-border bg-background/80 backdrop-blur">
      <nav aria-label="Primary" className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
        <Link to="/" className="font-mono text-sm font-semibold tracking-tight text-foreground">
          Jane Doe
        </Link>
        <div className="flex items-center gap-6 text-sm">
          <Link to="/work" className={linkClass}>
            Work
          </Link>
        </div>
      </nav>
    </header>
  )
}
