import { Button } from '~/components/ui/button'

/**
 * The 404 page (PORTAL §10, STRATEGY §24.36 36.5) — the styled sibling of
 * RouteErrorBoundary (36.3). Rendered by the root `notFoundComponent`, standalone
 * (no register layout), so it's self-sufficient: a `<main>` landmark (axe
 * `landmark-one-main`), honest copy, and a Go home escape hatch. Tier-2: centered
 * in a reserved region, never the bare placeholder it replaced.
 */
export function NotFound() {
  return (
    <main
      data-testid="not-found"
      className="mx-auto flex min-h-[24rem] w-full max-w-3xl flex-col items-center justify-center px-6 py-16"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-8 text-center">
        <p className="font-mono text-sm uppercase tracking-widest text-muted-foreground">404</p>
        <h1 className="text-lg font-semibold text-foreground">This page doesn&apos;t exist</h1>
        <p className="text-sm text-muted-foreground">
          The link may be broken or the page may have moved. Head back and pick up the trail from home.
        </p>
        <div className="mt-2">
          <Button asChild>
            <a href="/">Go home</a>
          </Button>
        </div>
      </div>
    </main>
  )
}
