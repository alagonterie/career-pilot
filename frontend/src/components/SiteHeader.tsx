import { Link } from '@tanstack/react-router'

/**
 * Slim site nav (PORTAL §8.1), shared by the marketing pages (`/`, `/work`) and
 * the ops pages (`/funnel`, with `/live` + `/architecture` to follow). A plain
 * shared component for now; promote to route-group layouts when `/contact` +
 * more ops pages land. Brand wordmark = the persona name (not a domain — the
 * deployed site is `hire.<DOMAIN>`); links right.
 */
export function SiteHeader() {
  const linkClass = 'text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground'
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
          <Link to="/funnel" className={linkClass}>
            Funnel
          </Link>
          <Link to="/architecture" className={linkClass}>
            Architecture
          </Link>
        </div>
      </nav>
    </header>
  )
}
