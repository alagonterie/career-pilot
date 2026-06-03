import { createFileRoute, Link } from '@tanstack/react-router'

import { SimActivity } from '~/components/simulator/SimActivity'
import { SimFallback } from '~/components/simulator/SimFallback'
import { SimInput } from '~/components/simulator/SimInput'
import { SimOutput } from '~/components/simulator/SimOutput'
import { Button } from '~/components/ui/button'
import { useSimulatorRun } from '~/lib/use-simulator-run'

// The Recruiter Simulator (PORTAL §5.3 / §24.31) — the grippiest spoke of the
// conversion spine. Input view (Apple register) → live 2-pane running view
// (SimActivity over the per-run SSE + SimOutput) → results view whose CTAs are
// the directed next step (so the marketing layout's ConnectiveRail self-renders
// nothing here). The backend shipped in Phase 5; this is the frontend over it.
export const Route = createFileRoute('/(marketing)/simulator/')({
  component: SimulatorPage,
  head: () => ({
    meta: [
      { title: 'Recruiter Simulator — Jane Doe' },
      {
        name: 'description',
        content: 'Run the real agent stack on your own role and watch it tailor a resume + draft outreach, live.',
      },
    ],
  }),
})

function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function SimulatorPage() {
  const run = useSimulatorRun()
  const showInput = run.status === 'idle' || run.status === 'starting'
  const showRun = run.status === 'running' || run.status === 'done'
  const wide = showRun // ops register once the run starts (§5.3)

  return (
    <main className={`mx-auto flex w-full flex-col px-6 py-16 ${wide ? 'max-w-6xl' : 'max-w-2xl'}`}>
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Try it on your own role</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Type a company and role. The same agent stack running my real job search will research it and draft a tailored
          pitch — live, in your browser. Nothing is saved.
        </p>
      </header>

      <div className="mt-10">
        {showInput ? <SimInput onRun={run.start} disabled={run.status === 'starting'} /> : null}

        {run.status === 'unavailable' ? <SimFallback kind="unavailable" onReset={run.reset} /> : null}
        {run.status === 'error' ? <SimFallback kind="error" message={run.errorMessage} onReset={run.reset} /> : null}

        {showRun ? (
          <>
            <div className="grid gap-6 lg:grid-cols-2">
              <SimActivity trace={run.trace} status={run.status} cost_usd={run.cost_usd} />
              <SimOutput text={run.output} pending={run.status === 'running'} />
            </div>

            {run.status === 'done' ? (
              <div data-testid="sim-results" className="mt-6 rounded-lg border border-border bg-card px-5 py-4">
                <p className="font-mono text-xs text-muted-foreground">
                  {run.cost_usd != null ? <>Total ${run.cost_usd.toFixed(2)} · </> : null}
                  <span data-testid="sim-volatile">
                    {run.elapsedMs != null ? `${Math.round(run.elapsedMs / 1000)}s elapsed · ` : ''}
                  </span>
                  sandbox torn down
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button asChild>
                    <Link
                      to="/contact"
                      search={{ company: run.input?.company, role: run.input?.role, from: 'simulator' }}
                      data-testid="sim-talk"
                    >
                      Talk to me →
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => downloadMarkdown('simulator-run.md', run.output)}
                    disabled={run.output.length === 0}
                  >
                    Download markdown
                  </Button>
                  {run.runId ? (
                    <Button asChild variant="outline">
                      <Link to="/simulator/results/$id" params={{ id: run.runId }} data-testid="sim-share">
                        Share these results
                      </Link>
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={run.reset}>
                    Try another
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  )
}
