import { Link } from '@tanstack/react-router'

/**
 * Slim site nav (PORTAL §8.1), shared by the marketing pages (`/`, `/work`) and
 * the ops pages (`/momentum`, `/architecture`, `/live`). Order = lead with the
 * wow (`/live`), cluster its drill-ins (`Momentum`, `Architecture`), then the
 * personal/conversion tail (`Simulator`, `Work`, `Contact`). "Momentum" is the
 * visitor label for the funnel page (`/momentum`); the internal naming stays
 * "funnel". `/about` is a footer link (§8.2), not a header item. Brand wordmark =
 * the persona name (not a domain — the deployed site is `hire.<DOMAIN>`).
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
          <Link to="/live" className={linkClass}>
            Live
          </Link>
          <Link to="/momentum" className={linkClass}>
            Momentum
          </Link>
          <Link to="/architecture" className={linkClass}>
            Architecture
          </Link>
          <Link to="/simulator" className={linkClass}>
            Simulator
          </Link>
          <Link to="/work" className={linkClass}>
            Work
          </Link>
          <Link to="/contact" className={linkClass}>
            Contact
          </Link>
        </div>
      </nav>
    </header>
  )
}
