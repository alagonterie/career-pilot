import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { SimActivity } from '~/components/simulator/SimActivity'
import { SimOutput } from '~/components/simulator/SimOutput'
import { Button } from '~/components/ui/button'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import type { SimTraceEvent } from '~/lib/use-simulator-run'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

// The read-only share page (PORTAL §5.3 — "forward it to your EM"). A recruiter's
// completed run, persisted for 30 days (simulator_runs), reachable at a stable
// URL. Client-only fetch (mirrors the app's other read surfaces); 404/expired is
// handled honestly. No ConnectiveRail here — its own CTAs are the next step.
export const Route = createFileRoute('/(marketing)/simulator/results/$id')({
  component: ShareResults,
  // SSR the real candidate name into the meta title (identity-SSR principle —
  // never the `Jane Doe` placeholder). The per-run dynamic OG (company/role in
  // og:title + a per-run og:image) still needs a Worker OG endpoint — deferred to
  // the Phase 9/10 deploy (STRATEGY §24.36 36.5).
  loader: () => getWorkProfile(),
  head: ({ loaderData }) => {
    const name = loaderData?.profile?.name
    return seo({
      title: name ? `Simulator result — ${name}` : 'Simulator result',
      description:
        'A recruiter-simulator run — the job-search agent tailoring a resume and drafting outreach for a role, live.',
      path: '/simulator',
    })
  },
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
  /** §24.72 9.4b-r2 — a downloadable tailored résumé PDF is available for this run. */
  has_tailored_resume?: boolean
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
            Shared runs are kept for 30 days, so this one has likely expired. Run your own — name a role and watch my
            agent tailor a résumé to it in a few minutes.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/simulator">Watch me apply to your role →</Link>
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
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Shared run · watch me apply
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              {state.row.visitor_role ?? 'Role'} @ {state.row.visitor_company ?? 'a company'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A tailored résumé and outreach my job-search agent built for this role, live.
              {state.row.total_cost_cents != null ? ` Cost $${(state.row.total_cost_cents / 100).toFixed(2)}.` : ''}
            </p>
          </header>

          {/* The gift, up top (§24.72): the tailored résumé is the thing to take. */}
          {state.row.has_tailored_resume ? (
            <div
              data-testid="share-gift"
              className="mt-8 rounded-xl border border-accent-cool/40 bg-accent-cool/5 px-6 py-5"
            >
              <p className="font-mono text-xs uppercase tracking-widest text-accent-cool">Your tailored résumé</p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">
                A full résumé, aimed at {state.row.visitor_role ?? 'your role'}
                {state.row.visitor_company ? ` @ ${state.row.visitor_company}` : ''}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Auto-tailored from my real experience for this exact role — yours to download and forward.
              </p>
              <div className="mt-4">
                <Button asChild size="lg">
                  <a
                    href={`${API_BASE}/api/simulator/results/${encodeURIComponent(state.row.id)}/resume.pdf`}
                    download
                    data-testid="share-download-resume"
                  >
                    Download tailored résumé (PDF) ↓
                  </a>
                </Button>
              </div>
            </div>
          ) : null}

          {/* The pitch the run produced — bullets + outreach — as supporting detail. */}
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
              <Link to="/simulator">Watch me apply to your role →</Link>
            </Button>
          </div>
        </>
      )}
    </main>
  )
}
