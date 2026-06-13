import { createFileRoute, Link } from '@tanstack/react-router'

import { FunnelCompact } from '~/components/live/FunnelCompact'
import { LogStream } from '~/components/live/LogStream'
import {
  ContainerPoolPanel,
  LlmSpendPanel,
  Panel,
  RecentOutcomesPanel,
  SessionsPanel,
  SystemStatusStrip,
  TelemetryPanel,
} from '~/components/live/panels'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { seo } from '~/lib/seo'
import { useActivityStream } from '~/lib/use-activity-stream'
import { useArchitecture } from '~/lib/use-architecture'
import { useFunnel } from '~/lib/use-funnel'
import { useObservability } from '~/lib/use-observability'
import { deriveTelemetryView, useTelemetry } from '~/lib/use-telemetry'

// Third page of the ops register (PORTAL §5.2). `(ops)` is pathless → the URL is
// still `/live`. The aggregate dashboard: it composes the 7.1 funnel + 7.2
// architecture pieces + the SSE trace + the telemetry endpoint — no new backend
// (§24.29). The `(ops)` shared layout stays deferred (a follow-up now that three
// ops pages exist).
export const Route = createFileRoute('/(ops)/live')({
  component: LivePage,
  // §24.60: `?app=«application_ref»` filters the trace stream to one
  // application (the /pipeline drawer's "Live activity →" destination).
  // Anything non-string is dropped — same contract as /pipeline's param.
  validateSearch: (search: Record<string, unknown>): { app?: string } => ({
    app: typeof search.app === 'string' && search.app.length > 0 ? search.app : undefined,
  }),
  head: () =>
    seo({
      title: 'Live — Jane Doe',
      description:
        'Real-time ops dashboard — the agent system running the job search, live: sessions, containers, cost, and the agent trace stream.',
      path: '/live',
    }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function LivePage() {
  const { arch, mode, status: archStatus } = useArchitecture(API_BASE)
  const { data: funnel, status: funnelStatus } = useFunnel(API_BASE)
  const { events, status, count } = useActivityStream(API_BASE, { limit: 60 })
  const { data: telemetry, status: telemetryStatus } = useTelemetry(API_BASE)
  const { data: observability, status: observabilityStatus } = useObservability(API_BASE)
  const { app: appFilter } = Route.useSearch()
  const navigate = Route.useNavigate()
  // Dismissing the app-filter chip clears the param via replace — arriving from
  // the drawer link, back should return to /pipeline, not re-apply the filter.
  const clearAppFilter = (): void => {
    void navigate({ search: {}, replace: true })
  }

  const view = deriveTelemetryView(telemetry)
  const apps = funnel?.applications ?? []

  return (
    <>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-12">
        <header className="order-1 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Live</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              The agent system running the job search, in real time — sessions, containers, cost, and every sanitized
              action as it happens.
            </p>
          </div>
          {/* System status rides the header unboxed (§24.69 follow-up) — it's
              page-level state, not a stat tile. */}
          <SystemStatusStrip mode={mode} status={archStatus} />
        </header>

        {/* centerpiece (trace) + right rail. Trace-first on a phone (§13): the
            "agent working now" wow leads instead of being buried under the stat
            tiles. It's first in the DOM (so mobile reading order == visual order),
            and `lg:order` floats the stat row back on top at desktop. The
            reordered stat panels are non-interactive display widgets, so the
            desktop focus order is unaffected and the primary content leads. */}
        <div className="order-2 grid grid-cols-1 gap-4 lg:order-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <LogStream
              events={events}
              status={status}
              count={count}
              appFilter={appFilter}
              onClearAppFilter={clearAppFilter}
            />
          </div>
          <div className="flex flex-col gap-4">
            <Panel
              title="Job Pipeline"
              // min-h reserves the loaded footprint so loading→ok doesn't shift
              // the rail (§24.36 Tier-2; the value is the measured loaded height).
              className="min-h-[152px]"
              action={
                <Link to="/pipeline" className="font-mono text-[11px] text-accent-cool hover:underline">
                  open →
                </Link>
              }
            >
              {funnelStatus === 'loading' ? (
                <Skeleton className="h-20 w-full" />
              ) : funnelStatus === 'error' ? (
                <StateNote tone="error" className="text-xs">
                  Offline — retrying…
                </StateNote>
              ) : (
                <FunnelCompact apps={apps} />
              )}
            </Panel>
            <RecentOutcomesPanel apps={apps} status={funnelStatus} />
          </div>
        </div>

        {/* top stat row — `grid-auto-rows` floors every panel to the MAX loaded
            row height so loading→ok never shifts (§24.36 Tier-2). The 4th tile is
            now LLM SPEND (the consolidated cost box, §24.69 follow-up) — an equal-
            size sibling of LLM telemetry; system status moved to the header strip. */}
        <div className="order-3 grid grid-cols-1 gap-4 [grid-auto-rows:minmax(196px,auto)] sm:grid-cols-2 lg:order-2 lg:grid-cols-4">
          <SessionsPanel arch={arch} status={archStatus} />
          <ContainerPoolPanel arch={arch} status={archStatus} />
          <TelemetryPanel view={view} status={telemetryStatus} />
          <LlmSpendPanel data={observability} status={observabilityStatus} />
        </div>

        <footer className="order-4 border-t border-border pt-6 text-[11px] leading-relaxed text-muted-foreground">
          Every line is sanitized public data — companies obfuscated by default, no PII. Per-line LLM telemetry (model,
          tokens, cost, cache) renders as it&apos;s captured; absent fields are simply not shown, never faked.
        </footer>
      </main>
    </>
  )
}
