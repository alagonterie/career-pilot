import { createFileRoute, Link } from '@tanstack/react-router'

import { SimActivity } from '~/components/simulator/SimActivity'
import { SimFallback } from '~/components/simulator/SimFallback'
import { SimInput } from '~/components/simulator/SimInput'
import { SimOutput } from '~/components/simulator/SimOutput'
import { SimResult } from '~/components/simulator/SimResult'
import { Button } from '~/components/ui/button'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import { stripTailoredResumeBlock } from '~/lib/strip-tailored'
import { useSimulatorRun } from '~/lib/use-simulator-run'

// "Watch me apply to your role" (PORTAL §5.3 / §24.31 / §24.72) — the grippiest
// spoke of the conversion spine. Input view (Apple register) → live 2-pane
// running view (SimActivity over the per-run SSE + SimOutput) → a GIFT-first
// done-state: the tailored résumé the agent built for this exact role is the
// hero a recruiter walks away with. Its own CTAs are the directed next step (so
// the marketing layout's ConnectiveRail self-renders nothing here).
export const Route = createFileRoute('/(marketing)/watch/')({
  component: SimulatorPage,
  // SSR the real candidate name into the meta title (identity-SSR principle —
  // never the `Jane Doe` placeholder); drop the name when no profile is composed.
  loader: () => getWorkProfile(),
  head: ({ loaderData }) => {
    const name = loaderData?.profile?.name
    return seo({
      title: name ? `Watch me apply to your role — ${name}` : 'Watch me apply to your role',
      description:
        'Name a company and role you’re hiring for — my job-search agent researches it and tailors my résumé + outreach to it, live. Nothing gets submitted; the tailored résumé is yours to download.',
      path: '/watch',
    })
  },
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
  const running = run.status === 'running'
  const done = run.status === 'done'
  // The 2-pane live grid needs width; the single-column gift-first results read
  // better narrower (the résumé preview + collapsed sections).
  const width = running ? 'max-w-6xl' : done ? 'max-w-3xl' : 'max-w-2xl'
  // The live SSE output is raw — strip the tailored-résumé JSON block so it never
  // shows in the output pane (the persisted/shared copy is stripped server-side).
  const cleanOutput = stripTailoredResumeBlock(run.output)

  return (
    <main className={`mx-auto flex w-full flex-col px-6 py-16 ${width}`}>
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Watch me apply to your role</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Name a company and role you’re hiring for. The same agent stack running my real job search researches it and
          tailors my résumé — plus a cold-outreach email — to it, live in your browser. Nothing gets submitted anywhere;
          the tailored résumé is yours to download when it’s done.
        </p>
      </header>

      <div className="mt-10">
        {showInput ? <SimInput onRun={run.start} disabled={run.status === 'starting'} /> : null}

        {run.status === 'unavailable' ? <SimFallback kind="unavailable" onReset={run.reset} /> : null}
        {run.status === 'error' ? <SimFallback kind="error" message={run.errorMessage} onReset={run.reset} /> : null}

        {/* Live run: the 2-pane "watch it work" grid (output stripped of the JSON). */}
        {running ? (
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <SimActivity trace={run.trace} status={run.status} cost_usd={run.cost_usd} startedAt={run.startedAt} />
            <SimOutput text={cleanOutput} pending />
          </div>
        ) : null}

        {/* Done: the gift-first results (shared with the /results share page), then
            the run meta + the directed next step. */}
        {done && run.runId ? (
          <div data-testid="sim-results" className="flex flex-col gap-6">
            <SimResult
              runId={run.runId}
              company={run.input?.company ?? null}
              role={run.input?.role ?? null}
              outputText={cleanOutput}
              trace={run.trace}
              costUsd={run.cost_usd}
              hasTailoredResume={run.hasTailoredResume}
            />

            <div className="rounded-lg border border-border bg-card px-5 py-4">
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
                <Button asChild variant="outline">
                  <Link to="/watch/results/$id" params={{ id: run.runId }} data-testid="sim-share">
                    Share this result
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => downloadMarkdown('watch-me-apply.md', cleanOutput)}
                  disabled={cleanOutput.length === 0}
                >
                  Download transcript
                </Button>
                <Button variant="ghost" onClick={run.reset}>
                  Try another role
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  )
}
