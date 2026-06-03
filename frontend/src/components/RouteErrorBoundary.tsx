import { type ErrorComponentProps } from '@tanstack/react-router'

import { Button } from '~/components/ui/button'

/**
 * The recoverable route error boundary (PORTAL §10, STRATEGY §24.36 36.3). Wired
 * as the router `defaultErrorComponent` — so an *unexpected render throw* in a
 * leaf route renders here, inside that route's parent layout `<Outlet/>`: the
 * `SiteHeader` + `ConnectiveRail` persist, so a crash is never a chromeless page
 * — and as the root `errorComponent` (the last-resort, standalone, no shell).
 *
 * Distinct from the per-surface offline `StateNote` (36.1), which handles the
 * *expected* async failure (a fetch that rejects). This catches the bug-shaped
 * throw. On-brand + recoverable: **Try again** resets the boundary so the route
 * re-mounts (the polling hooks re-fetch a transient failure), **Go home** is the
 * escape hatch. The raw error/stack shows only under `import.meta.env.DEV` —
 * visitors never see a trace, and the production render stays deterministic for
 * the visual baseline. Tier-2 (§10): centered in a reserved region, never a
 * white screen.
 */
export function RouteErrorBoundary({ error, reset }: ErrorComponentProps) {
  return (
    <main
      data-testid="route-error"
      className="mx-auto flex min-h-[24rem] w-full max-w-3xl flex-col items-center justify-center px-6 py-16"
    >
      {/* `role="alert"` on the card (not the <main>) so the error is announced
          without overriding the main landmark axe requires on every page. */}
      <div
        role="alert"
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-8 text-center"
      >
        <h1 className="text-lg font-semibold text-foreground">This view ran into a problem</h1>
        <p className="text-sm text-muted-foreground">
          Something on this page failed to render. Nothing was lost — try again, or head back home.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => reset()} data-testid="route-error-retry">
            Try again
          </Button>
          <Button asChild variant="outline">
            <a href="/">Go home</a>
          </Button>
        </div>
        {import.meta.env.DEV ? (
          <pre
            data-testid="route-error-detail"
            className="mt-4 max-h-48 w-full overflow-auto rounded border border-border bg-muted/50 p-3 text-left font-mono text-[11px] text-muted-foreground"
          >
            {error instanceof Error ? (error.stack ?? error.message) : String(error)}
          </pre>
        ) : null}
      </div>
    </main>
  )
}
