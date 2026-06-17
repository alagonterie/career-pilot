import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '~/components/ui/button'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

interface RecentRun {
  id: string
  visitor_company: string | null
  visitor_role: string | null
}

/**
 * The simulator's honest fallback (PORTAL §5.3 disabled state) — shown when a run
 * can't start: `unavailable` (the orchestrator is paused / the sandbox adapter is
 * down → `POST /api/simulator` 503) or `error` (network / bad response). It
 * surfaces the recent shareable runs (still browsable when the live simulator is
 * off, via `GET /api/simulator/recent`) plus the always-open conversion path.
 * Client-only fetch (mirrors the app's other read surfaces).
 */
export function SimFallback({
  kind,
  message,
  onReset,
}: {
  kind: 'unavailable' | 'error'
  message?: string | null
  onReset: () => void
}) {
  const [recent, setRecent] = React.useState<RecentRun[]>([])

  React.useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/simulator/recent`, { signal: ac.signal })
        if (!res.ok) return
        const data = (await res.json()) as { runs?: RecentRun[] }
        if (Array.isArray(data.runs)) setRecent(data.runs)
      } catch {
        // best-effort — the fallback works without the recent list
      }
    })()
    return () => ac.abort()
  }, [])

  return (
    <div data-testid={`sim-${kind}`} className="rounded-lg border border-border bg-card p-6">
      <p className="font-medium text-foreground">
        {kind === 'unavailable' ? 'This is taking a breather.' : 'That run didn’t finish.'}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {message ??
          (kind === 'unavailable'
            ? 'The orchestrator is paused for review — it’s back when it’s back. Recent runs are still browsable below.'
            : 'Something interrupted the run. You can try again, or reach out directly.')}
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={onReset}>Try again</Button>
        <Button asChild variant="outline">
          <Link to="/contact" search={{ from: 'simulator' }}>
            Talk to me →
          </Link>
        </Button>
      </div>

      {recent.length > 0 ? (
        <div className="mt-6 border-t border-border pt-4">
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Recent runs</p>
          <ul data-testid="sim-recent" className="mt-2 flex flex-col gap-1.5 text-sm">
            {recent.map((r) => (
              <li key={r.id}>
                <Link to="/watch/results/$id" params={{ id: r.id }} className="text-accent-cool hover:underline">
                  {r.visitor_role ?? 'Role'} @ {r.visitor_company ?? 'a company'} →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
