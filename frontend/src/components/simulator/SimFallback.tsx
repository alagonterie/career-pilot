import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '~/components/ui/button'
import type { SimDegradeReason } from '~/lib/sim-degrade'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

interface RecentRun {
  id: string
  visitor_company: string | null
  visitor_role: string | null
}

interface FallbackCopy {
  title: string
  body: string
}

/**
 * Per-variant headline + body (PORTAL §5.3 / STRATEGY §24.150 D2). An `unavailable`
 * with a branded reason reframes the cap the visitor just hit as proof the showcase
 * is real (it costs real money and can run out) and points them at the surface that
 * explains it; the generic unavailable + the error variant stay honest about a real
 * fault (no "feature" spin on a crash). Pure.
 */
function fallbackCopy(
  kind: 'unavailable' | 'error',
  reason: SimDegradeReason | null,
  message?: string | null,
): FallbackCopy {
  if (kind === 'error') {
    return {
      title: 'That run didn’t finish.',
      body: message ?? 'Something interrupted the run. You can try again, or reach out directly.',
    }
  }
  switch (reason) {
    case 'budget':
      return {
        title: 'The agent’s been busy today.',
        body: 'It’s spent today’s sandbox budget running live for other visitors — every run burns real LLM tokens, so I cap the daily spend and the showcase throttles itself rather than running away. Fresh budget tomorrow.',
      }
    case 'rate_limit':
      return {
        title: 'You’ve used today’s runs.',
        body: 'I cap runs per visitor so one person can’t drain the sandbox for everyone — your allotment resets tomorrow. Everything else is live in the meantime.',
      }
    case 'disabled':
      return {
        title: 'The live sandbox is paused.',
        body: 'I’ve paused new runs for review — but the system itself is fully live. The real job-search pipeline, the spend ledger, and the system map are all still running.',
      }
    default:
      return {
        title: 'This is taking a breather.',
        body: 'The live sandbox is catching its breath — try again in a moment. Recent runs are still browsable below.',
      }
  }
}

/**
 * The per-variant calls to action (§24.150 D2/D3). A branded reason swaps the bare
 * retry for CTAs into the surface that explains the cap (budget → the spend ledger +
 * the self-throttling system-map node; per-IP / paused → the real pipeline + map);
 * the generic/error path keeps the retry. "Talk to me →" (the always-open conversion
 * path, D3) is appended to every variant.
 */
function DegradeActions({
  kind,
  reason,
  onReset,
}: {
  kind: 'unavailable' | 'error'
  reason: SimDegradeReason | null
  onReset: () => void
}) {
  const talk = (
    <Button asChild variant="outline">
      <Link to="/contact" search={{ from: 'simulator' }} data-testid="sim-degrade-contact">
        Talk to me →
      </Link>
    </Button>
  )

  if (kind === 'unavailable' && reason === 'budget') {
    return (
      <>
        <Button asChild>
          <Link to="/dashboard" data-testid="sim-degrade-dashboard">
            See where it went →
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/architecture" data-testid="sim-degrade-architecture">
            Watch it throttle →
          </Link>
        </Button>
        {talk}
      </>
    )
  }
  if (kind === 'unavailable' && reason === 'rate_limit') {
    return (
      <>
        <Button asChild>
          <Link to="/pipeline" data-testid="sim-degrade-pipeline">
            See the real pipeline →
          </Link>
        </Button>
        {talk}
      </>
    )
  }
  if (kind === 'unavailable' && reason === 'disabled') {
    return (
      <>
        <Button asChild>
          <Link to="/pipeline" data-testid="sim-degrade-pipeline">
            See the pipeline →
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/architecture" data-testid="sim-degrade-architecture">
            System map →
          </Link>
        </Button>
        {talk}
      </>
    )
  }
  // Generic unavailable (a transient backend fault) + the error variant: an honest
  // retry, plus the conversion path.
  return (
    <>
      <Button onClick={onReset}>Try again</Button>
      {talk}
    </>
  )
}

/**
 * The simulator's honest fallback (PORTAL §5.3 disabled state). Shown when a run
 * can't start: `unavailable` (the orchestrator is paused, the daily budget / per-IP
 * cap is hit, or the sandbox adapter is down) or `error` (network / bad response).
 * The `reason` (§24.150) brands an `unavailable` into a "degradation as a feature"
 * state — the cap becomes a guided tour of the surface that explains it, rather than
 * a dead end. It surfaces the recent shareable runs (still browsable when the live
 * simulator is off, via `GET /api/simulator/recent`) plus the always-open
 * conversion path. Client-only fetch (mirrors the app's other read surfaces).
 */
export function SimFallback({
  kind,
  reason = null,
  message,
  onReset,
}: {
  kind: 'unavailable' | 'error'
  reason?: SimDegradeReason | null
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

  const copy = fallbackCopy(kind, reason, message)
  // A branded degradation reads as "by design" (an accent frame, matching the
  // concluded-retrospective register) vs the neutral card of a real fault.
  const branded = kind === 'unavailable' && reason !== null

  return (
    <div
      data-testid={`sim-${kind}`}
      data-degrade={branded ? reason : undefined}
      className={`rounded-lg border p-6 ${branded ? 'border-primary/30 bg-primary/5' : 'border-border bg-card'}`}
    >
      <p className="font-medium text-foreground">{copy.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        <DegradeActions kind={kind} reason={reason} onReset={onReset} />
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
