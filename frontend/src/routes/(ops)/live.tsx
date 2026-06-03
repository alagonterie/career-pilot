import { createFileRoute, Link } from '@tanstack/react-router'

import { FunnelCompact } from '~/components/live/FunnelCompact'
import { LogStream } from '~/components/live/LogStream'
import {
  ContainerPoolPanel,
  CostCachePanel,
  Panel,
  RecentOutcomesPanel,
  SessionsPanel,
  SystemStatusPanel,
  TelemetryPanel,
} from '~/components/live/panels'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { useActivityStream } from '~/lib/use-activity-stream'
import { useArchitecture } from '~/lib/use-architecture'
import { useFunnel } from '~/lib/use-funnel'
import { deriveTelemetryView, useTelemetry } from '~/lib/use-telemetry'

// Third page of the ops register (PORTAL §5.2). `(ops)` is pathless → the URL is
// still `/live`. The aggregate dashboard: it composes the 7.1 funnel + 7.2
// architecture pieces + the SSE trace + the telemetry endpoint — no new backend
// (§24.29). The `(ops)` shared layout stays deferred (a follow-up now that three
// ops pages exist).
export const Route = createFileRoute('/(ops)/live')({
  component: LivePage,
  head: () => ({
    meta: [
      { title: 'Live — Jane Doe' },
      {
        name: 'description',
        content:
          'Real-time ops dashboard — the agent system running the job search, live: sessions, containers, cost, and the agent trace stream.',
      },
    ],
  }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function LivePage() {
  const { arch, mode, status: archStatus } = useArchitecture(API_BASE)
  const { data: funnel, status: funnelStatus } = useFunnel(API_BASE)
  const { events, status, count } = useActivityStream(API_BASE, 60)
  const { data: telemetry, status: telemetryStatus } = useTelemetry(API_BASE)

  const view = deriveTelemetryView(telemetry)
  const apps = funnel?.applications ?? []

  return (
    <>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-12">
        <header>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Live</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The agent system running the job search, in real time — sessions, containers, cost, and every sanitized
            action as it happens.
          </p>
        </header>

        {/* top stat row — `grid-auto-rows` floors every panel to the MAX loaded
            row height so loading→ok never shifts (§24.36 Tier-2), regardless of
            whether LLM-telemetry loads connected (taller metrics) or not (shorter
            "not connected" copy). 196px = the connected height; the grid already
            equalizes the row, this pins its floor across states + data. */}
        <div className="grid grid-cols-1 gap-4 [grid-auto-rows:minmax(196px,auto)] sm:grid-cols-2 lg:grid-cols-4">
          <SystemStatusPanel mode={mode} arch={arch} status={archStatus} />
          <SessionsPanel arch={arch} status={archStatus} />
          <ContainerPoolPanel arch={arch} status={archStatus} />
          <TelemetryPanel view={view} status={telemetryStatus} />
        </div>

        {/* centerpiece (trace) + right rail */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <LogStream events={events} status={status} count={count} />
          </div>
          <div className="flex flex-col gap-4">
            <Panel
              title="Funnel"
              // min-h reserves the loaded footprint so loading→ok doesn't shift
              // the rail (§24.36 Tier-2; the value is the measured loaded height).
              className="min-h-[152px]"
              action={
                <Link to="/funnel" className="font-mono text-[11px] text-accent-cool hover:underline">
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
            <CostCachePanel view={view} status={telemetryStatus} />
            <RecentOutcomesPanel apps={apps} status={funnelStatus} />
          </div>
        </div>

        <footer className="border-t border-border pt-6 text-[11px] leading-relaxed text-muted-foreground">
          Every line is sanitized public data — companies obfuscated by default, no PII. Per-line LLM telemetry (model,
          tokens, cost, cache) renders as it&apos;s captured; absent fields are simply not shown, never faked.
        </footer>
      </main>
    </>
  )
}
