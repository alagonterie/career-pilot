import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { InfoTip } from '~/components/InfoTip'
import { ModeBanner } from '~/components/architecture/ModeBanner'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { FunnelApplication } from '~/lib/use-funnel'
import type { PollStatus } from '~/lib/use-polled-json'
import type { TelemetryView } from '~/lib/use-telemetry'

/** Loading twin for a panel body (§24.36 36.1) — a couple of metric-sized
 * skeletons so the panel keeps its shape while its endpoint is polled. The
 * panels that the rail composes (`Cost & cache`, `Recent outcomes`) carry a
 * `min-h` sized to their MAX loaded footprint (Portkey connected / 6 recent rows
 * — the taller of the data variants), so loading→ok reserves the same height
 * regardless of which data loads and the trace stream (which is `h-full`, sized
 * by the rail) doesn't collapse — the §24.36 Tier-2 stability standard. */
function PanelSkeleton({ lines = 1 }: { lines?: number }) {
  return (
    <div data-testid="panel-skeleton" className="flex flex-col gap-2">
      <Skeleton className="h-7 w-20" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3 w-28" />
      ))}
    </div>
  )
}

/** The honest offline note shared by every panel's error branch. */
function PanelOffline() {
  return (
    <StateNote tone="error" className="text-xs">
      Offline — retrying…
    </StateNote>
  )
}

/** A titled ops-panel card — the shared shell for the /live grid. */
export function Panel({
  title,
  children,
  className,
  action,
}: {
  title: string
  children: ReactNode
  className?: string
  action?: ReactNode
}) {
  return (
    <section className={['flex flex-col gap-3 rounded-lg border border-border bg-card p-4', className ?? ''].join(' ')}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A single big-number readout. `info` hangs an InfoTip off the label —
 * the §24.57 explain-on-tap affordance for metric jargon. */
function Metric({ value, label, testId, info }: { value: string; label: string; testId?: string; info?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span data-testid={testId} className="font-mono text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
        {info ? <InfoTip label={label}>{info}</InfoTip> : null}
      </span>
    </div>
  )
}

/** Compact latency readout — turn durations are seconds-scale, so render ≥1s as
 * whole seconds ("12s" — decimals aren't worth the width) and sub-second as "840ms". */
function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

/** SYSTEM STATUS — reuses the architecture ModeBanner (mode + pause ladder) plus
 * a backend-health dot. UPTIME / LAST-DEPLOY need a host field no endpoint
 * exposes yet, so they're omitted rather than faked (§24.29). */
export function SystemStatusPanel({
  mode,
  arch,
  status,
}: {
  mode: SystemMode | null
  arch: ArchitectureData | null
  status?: PollStatus
}) {
  const online = arch?.backend === 'online'
  return (
    <Panel title="System status">
      {status === 'loading' ? (
        <PanelSkeleton lines={1} />
      ) : status === 'error' ? (
        <PanelOffline />
      ) : (
        <>
          {/* compact: shadow/pause-reason explainers ride the chips' tooltips so
              this panel's height is mode-independent and doesn't outgrow the
              equalized stat row in SHADOW mode (§24.36). */}
          <ModeBanner mode={mode} compact />
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${online ? 'bg-primary' : 'bg-muted-foreground'}`}
            />
            <span className="font-mono text-xs text-muted-foreground">backend {arch?.backend ?? '—'}</span>
          </div>
        </>
      )}
    </Panel>
  )
}

/** ACTIVE SESSIONS — live counts from /api/architecture (the 24h history chart
 * needs a series endpoint → deferred). */
export function SessionsPanel({ arch, status }: { arch: ArchitectureData | null; status?: PollStatus }) {
  const running = arch?.sessions.running
  const active = arch?.sessions.active
  return (
    <Panel title="Active sessions">
      {status === 'loading' ? (
        <PanelSkeleton />
      ) : status === 'error' ? (
        <PanelOffline />
      ) : (
        <div className="flex items-end gap-6">
          <Metric value={running != null ? String(running) : '—'} label="running" />
          <Metric value={active != null ? String(active) : '—'} label="active" />
        </div>
      )}
    </Panel>
  )
}

/** CONTAINER POOL — running / capacity + a memory-utilization readout, reusing
 * 7.2's /api/architecture container shape. */
export function ContainerPoolPanel({ arch, status }: { arch: ArchitectureData | null; status?: PollStatus }) {
  const c = arch?.containers
  const running = c?.running ?? null
  const cap = c?.capacity_max ?? null
  const down = c?.runtime === 'down'
  const pct = c && running != null && cap ? Math.round((running / cap) * 100) : 0
  const memUsed = c && running != null ? running * c.memory_mb_each : null
  if (status === 'loading') {
    return (
      <Panel title="Container pool">
        <PanelSkeleton />
      </Panel>
    )
  }
  if (status === 'error') {
    return (
      <Panel title="Container pool">
        <PanelOffline />
      </Panel>
    )
  }
  return (
    <Panel title="Container pool">
      <Metric
        value={!down && running != null && cap != null ? `${running} / ${cap}` : down ? 'down' : '—'}
        label="running / max"
      />
      {c && !down ? (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            {memUsed != null ? `${memUsed} MB` : '—'} used · {c.memory_mb_each} MB each
          </span>
        </div>
      ) : null}
    </Panel>
  )
}

/** LLM TELEMETRY — derived from the local per-turn capture (§24.34/§24.47): turn
 * count + latency p50/p95 + top model, aggregated over captured turns; the
 * always-real local activity aggregates render unconditionally. (Cache lives in
 * the Cost & cache panel — no duplication.) Honest labels — "turns" (not raw
 * gateway requests), "turn p50/p95" (whole turn, not per-request). */
export function TelemetryPanel({ view, status }: { view: TelemetryView; status?: PollStatus }) {
  const local = view.local
  if (status === 'loading') {
    return (
      <Panel title="LLM telemetry">
        <PanelSkeleton lines={2} />
      </Panel>
    )
  }
  if (status === 'error') {
    return (
      <Panel title="LLM telemetry">
        <PanelOffline />
      </Panel>
    )
  }
  return (
    <Panel title="LLM telemetry">
      {view.hasTurns && local ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Metric value={local.turns_total.toLocaleString()} label="turns" />
            {local.turn_p50_ms != null ? (
              <Metric
                value={fmtLatency(local.turn_p50_ms)}
                label="turn p50"
                info="Median whole-turn API duration across captured agent turns — one turn is a full agent invocation (often many model calls), not a single request. p95 is the slow tail."
              />
            ) : null}
            {local.turn_p95_ms != null ? <Metric value={fmtLatency(local.turn_p95_ms)} label="turn p95" /> : null}
          </div>
          {local.top_model ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              top model: <span className="text-foreground">{local.top_model}</span>
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="telemetry-pending" className="font-mono text-xs text-muted-foreground">
          Awaiting the first captured agent turn. Metrics are summed from per-turn SDK usage (estimated).
        </p>
      )}
      {local ? (
        // The local aggregates are real but wall-clock-windowed (and would shift
        // if a parallel test pushed an audit row); `live-volatile` lets the
        // visual baseline mask the whole line — the numbers are covered by tests.
        <div
          data-testid="live-volatile"
          className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 font-mono text-[11px] text-muted-foreground"
        >
          <span>{local.activity_events_24h} events / 24h</span>
          <span>{local.activity_events_total} total</span>
          <span>{local.simulator_runs_total} sim runs</span>
        </div>
      ) : null}
    </Panel>
  )
}

/** COST & CACHE — the COMBINED estimated spend (§24.55): owner agent turns
 * (per-turn capture, §24.34/§24.47) + public simulator runs (per-run capture),
 * plus the cache-read rate. cost is an SDK *estimate* (labeled "est"), not a
 * billed number; the headline is lifetime, the bottom line carries the windowed
 * "today" detail broken down by lane (masked in the visual baseline —
 * wall-clock). */
export function CostCachePanel({ view, status }: { view: TelemetryView; status?: PollStatus }) {
  const local = view.local
  const hasSpend = view.hasTurns || (local?.sim_cost_cents_total ?? 0) > 0
  if (status === 'loading') {
    return (
      <Panel title="Cost & cache" className="min-h-[175px]">
        <PanelSkeleton lines={1} />
      </Panel>
    )
  }
  if (status === 'error') {
    return (
      <Panel title="Cost & cache" className="min-h-[175px]">
        <PanelOffline />
      </Panel>
    )
  }
  return (
    <Panel title="Cost & cache" className="min-h-[175px]">
      {hasSpend && local ? (
        <>
          <Metric
            testId="local-spend"
            value={`$${((local.turn_cost_cents_total + local.sim_cost_cents_total) / 100).toFixed(2)}`}
            label="spend · est"
            info="Lifetime estimated LLM spend: the owner agent's per-turn usage plus public simulator runs, priced by the SDK — an estimate, not a bill (server-side fees like web search aren't included)."
          />
          {local.cache_hit_rate != null ? (
            <p className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              {Math.round(local.cache_hit_rate * 100)}% of prompt tokens served from cache.
              <InfoTip label="cache rate">
                Prompt caching re-serves unchanged context (the agent&apos;s instructions, tools, history) instead of
                reprocessing it — cached tokens cost about a tenth of fresh ones. Higher is cheaper.
              </InfoTip>
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="cost-pending" className="font-mono text-xs text-muted-foreground">
          No agent spend captured yet — the estimate sums per-turn SDK usage as turns land.
        </p>
      )}
      {local ? (
        // The windowed "today" detail is wall-clock-windowed (and would shift if a
        // parallel test pushed a turn row); `live-volatile` lets the visual
        // baseline mask the line — the values are covered by the unit + E2E tests.
        <div
          data-testid="live-volatile"
          className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 font-mono text-[11px] text-muted-foreground"
        >
          <span>${((local.turn_cost_cents_24h + local.sim_cost_cents_24h) / 100).toFixed(2)} today</span>
          <span>agent ${(local.turn_cost_cents_24h / 100).toFixed(2)}</span>
          <span>sim ${(local.sim_cost_cents_24h / 100).toFixed(2)}</span>
        </div>
      ) : null}
    </Panel>
  )
}

/** RECENT OUTCOMES — the most-recently-active applications with current stage +
 * the ◆ public marker, from the already-polled funnel rows. An honest
 * current-state snapshot; true transition arrows need the deferred
 * funnel_events history (§24.29). */
export function RecentOutcomesPanel({ apps, status }: { apps: FunnelApplication[]; status?: PollStatus }) {
  const recent = apps
    .filter((a) => a.last_activity_at != null)
    .slice()
    .sort((a, b) => (b.last_activity_at as string).localeCompare(a.last_activity_at as string))
    .slice(0, 6)
  if (status === 'loading') {
    return (
      <Panel title="Recent outcomes" className="min-h-[188px]">
        <PanelSkeleton lines={3} />
      </Panel>
    )
  }
  if (status === 'error') {
    return (
      <Panel title="Recent outcomes" className="min-h-[188px]">
        <PanelOffline />
      </Panel>
    )
  }
  return (
    <Panel title="Recent outcomes" className="min-h-[188px]">
      {recent.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <ol data-testid="recent-outcomes" className="flex flex-col gap-1.5 font-mono text-xs">
          {/* Each row deep-links into the /momentum drawer for that application
              (§24.57) — the static outcome list becomes navigation into the
              detail panel that already exists there. */}
          {recent.map((a) => {
            const isPublic = a.public_state === 'public'
            return (
              <li key={a.application_ref}>
                <Link
                  to="/momentum"
                  search={{ app: a.application_ref }}
                  data-testid="recent-outcome-link"
                  className="group flex items-center justify-between gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-foreground group-hover:underline">
                    {isPublic ? a.application_ref : `[${a.application_ref}]`}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="uppercase tracking-wider text-muted-foreground">{a.stage}</span>
                    {isPublic ? <span className="text-primary">◆</span> : null}
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
