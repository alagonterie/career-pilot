import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { SimActivity } from '~/components/simulator/SimActivity'
import { SimOutput } from '~/components/simulator/SimOutput'
import { Button } from '~/components/ui/button'
import { seo } from '~/lib/seo'
import type { SimTraceEvent } from '~/lib/use-simulator-run'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

// The read-only share page (PORTAL §5.3 — "forward it to your EM"). A recruiter's
// completed run, persisted for 30 days (simulator_runs), reachable at a stable
// URL. Client-only fetch (mirrors the app's other read surfaces); 404/expired is
// handled honestly. No ConnectiveRail here — its own CTAs are the next step.
export const Route = createFileRoute('/(marketing)/simulator/results/$id')({
  component: ShareResults,
  // Static share meta. The dynamic per-run preview (the run's company/role in
  // og:title + a per-run og:image) needs a route loader + a Worker dynamic-OG
  // endpoint — deferred to the Phase 9/10 deploy (STRATEGY §24.36 36.5).
  head: () =>
    seo({
      title: 'Simulator result — Jane Doe',
      description:
        'A recruiter-simulator run — the job-search agent tailoring a resume and drafting outreach for a role, live.',
      path: '/simulator',
    }),
})

/**
 * The run's persisted activity trace, collapsed by default (§24.31 Δ — "see
 * how this actually worked" depth for forwarded links). Renders nothing when
 * the run predates trace persistence.
 */
function ShareActivity({ trace, cost_usd }: { trace: SimTraceEvent[]; cost_usd: number | null }) {
  const [open, setOpen] = React.useState(false)
  if (trace.length === 0) return null
  return (
    <div className="mt-4" data-testid="share-activity">
      <button
        type="button"
        data-testid="share-activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {open ? 'Hide the run activity' : `See how this run worked (${trace.length} steps)`}
      </button>
      {open ? (
        <div className="mt-3">
          <SimActivity trace={trace} status="done" cost_usd={cost_usd} />
        </div>
      ) : null}
    </div>
  )
}

interface SimRunRow {
  id: string
  visitor_company: string | null
  visitor_role: string | null
  tailored_resume: string | null
  total_cost_cents: number | null
  trace_json: string | null
}

/** Parse the persisted run trace (§24.31 Δ) — null-safe, shape-guarded. */
function parseTrace(raw: string | null): SimTraceEvent[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is SimTraceEvent => e != null && typeof e === 'object' && 't' in e)
  } catch {
    return []
  }
}

type LoadState = { status: 'loading' } | { status: 'ok'; row: SimRunRow } | { status: 'missing' }

function ShareResults() {
  const { id } = Route.useParams()
  const [state, setState] = React.useState<LoadState>({ status: 'loading' })

  React.useEffect(() => {
    const ac = new AbortController()
    setState({ status: 'loading' })
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/simulator/results/${encodeURIComponent(id)}`, { signal: ac.signal })
        if (res.status === 404) {
          setState({ status: 'missing' })
          return
        }
        if (!res.ok) {
          setState({ status: 'missing' })
          return
        }
        const row = (await res.json()) as SimRunRow
        setState({ status: 'ok', row })
      } catch {
        if (!ac.signal.aborted) setState({ status: 'missing' })
      }
    })()
    return () => ac.abort()
  }, [id])

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col px-6 py-16">
      {state.status === 'loading' ? (
        <p data-testid="share-loading" className="text-sm text-muted-foreground">
          Loading the run…
        </p>
      ) : state.status === 'missing' ? (
        <div data-testid="share-missing" className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-bold tracking-tight">This result isn’t available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Shared simulator runs are kept for 30 days, so this one has likely expired. Run your own — it takes a few
            minutes and you watch every step.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/simulator">Run the simulator →</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/contact" search={{ from: 'simulator' }}>
                Talk to me →
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <header>
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Shared simulator run</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              {state.row.visitor_role ?? 'Role'} @ {state.row.visitor_company ?? 'a company'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A read-only result the recruiter simulator produced.
              {state.row.total_cost_cents != null ? ` Cost $${(state.row.total_cost_cents / 100).toFixed(2)}.` : ''}
            </p>
          </header>

          <div className="mt-8">
            <SimOutput text={state.row.tailored_resume ?? ''} />
          </div>

          <ShareActivity
            trace={parseTrace(state.row.trace_json)}
            cost_usd={state.row.total_cost_cents != null ? state.row.total_cost_cents / 100 : null}
          />

          <div className="mt-8 flex flex-wrap gap-3 border-t border-border pt-6">
            <Button asChild>
              <Link
                to="/contact"
                search={{ company: state.row.visitor_company ?? undefined, from: 'simulator' }}
                data-testid="share-talk"
              >
                Talk to me →
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/simulator">Try your own role →</Link>
            </Button>
          </div>
        </>
      )}
    </main>
  )
}
