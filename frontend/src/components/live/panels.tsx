import type { ReactNode } from 'react'

import { ModeBanner } from '~/components/architecture/ModeBanner'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { FunnelApplication } from '~/lib/use-funnel'
import type { TelemetryView } from '~/lib/use-telemetry'

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

/** A single big-number readout. */
function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
    </div>
  )
}

/** SYSTEM STATUS — reuses the architecture ModeBanner (mode + pause ladder) plus
 * a backend-health dot. UPTIME / LAST-DEPLOY need a host field no endpoint
 * exposes yet, so they're omitted rather than faked (§24.29). */
export function SystemStatusPanel({ mode, arch }: { mode: SystemMode | null; arch: ArchitectureData | null }) {
  const online = arch?.backend === 'online'
  return (
    <Panel title="System status">
      <ModeBanner mode={mode} />
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${online ? 'bg-primary' : 'bg-muted-foreground'}`}
        />
        <span className="font-mono text-xs text-muted-foreground">backend {arch?.backend ?? '—'}</span>
      </div>
    </Panel>
  )
}

/** ACTIVE SESSIONS — live counts from /api/architecture (the 24h history chart
 * needs a series endpoint → deferred). */
export function SessionsPanel({ arch }: { arch: ArchitectureData | null }) {
  const running = arch?.sessions.running
  const active = arch?.sessions.active
  return (
    <Panel title="Active sessions">
      <div className="flex items-end gap-6">
        <Metric value={running != null ? String(running) : '—'} label="running" />
        <Metric value={active != null ? String(active) : '—'} label="active" />
      </div>
    </Panel>
  )
}

/** CONTAINER POOL — running / capacity + a memory-utilization readout, reusing
 * 7.2's /api/architecture container shape. */
export function ContainerPoolPanel({ arch }: { arch: ArchitectureData | null }) {
  const c = arch?.containers
  const running = c?.running ?? null
  const cap = c?.capacity_max ?? null
  const down = c?.runtime === 'down'
  const pct = c && running != null && cap ? Math.round((running / cap) * 100) : 0
  const memUsed = c && running != null ? running * c.memory_mb_each : null
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

/** LLM TELEMETRY — Portkey lanes when available, else the honest "not connected"
 * state; the always-real local aggregates render unconditionally (§24.29). */
export function TelemetryPanel({ view }: { view: TelemetryView }) {
  const s = view.summary
  return (
    <Panel title="LLM telemetry">
      {view.available && s ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            {s.cache_hit_rate != null ? (
              <Metric value={`${Math.round(s.cache_hit_rate * 100)}%`} label="cache hit" />
            ) : null}
            {s.total_requests != null ? <Metric value={s.total_requests.toLocaleString()} label="req 24h" /> : null}
            {s.p50_latency_ms != null ? <Metric value={`${s.p50_latency_ms}ms`} label="p50" /> : null}
          </div>
          {s.top_model ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              top model: <span className="text-foreground">{s.top_model}</span>
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="telemetry-unavailable" className="font-mono text-xs text-muted-foreground">
          Portkey analytics not connected{view.reason ? ` — ${view.reason}` : ''}. Live LLM telemetry lands with the
          capture phase.
        </p>
      )}
      {view.local ? (
        // The local aggregates are real but wall-clock-windowed (and would shift
        // if a parallel test pushed an audit row); `live-volatile` lets the
        // visual baseline mask the whole line — the numbers are covered by tests.
        <div
          data-testid="live-volatile"
          className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 font-mono text-[11px] text-muted-foreground"
        >
          <span>{view.local.activity_events_24h} events / 24h</span>
          <span>{view.local.activity_events_total} total</span>
          <span>{view.local.simulator_runs_total} sim runs</span>
        </div>
      ) : null}
    </Panel>
  )
}

/** COST & CACHE — Portkey-sourced spend when available, else the honest pending
 * state (the "~$X/day" tagline renders only with a real number — §24.29). */
export function CostCachePanel({ view }: { view: TelemetryView }) {
  const s = view.summary
  const local = view.local
  return (
    <Panel title="Cost & cache">
      {view.available && s && s.total_cost_usd != null ? (
        <>
          <Metric value={`$${s.total_cost_usd.toFixed(2)}`} label="spend today" />
          {s.cache_hit_rate != null ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              {Math.round(s.cache_hit_rate * 100)}% of calls served from cache.
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="cost-unavailable" className="font-mono text-xs text-muted-foreground">
          Portkey cost analytics not connected{view.reason ? ` — ${view.reason}` : ''}. The local estimate below is
          summed from captured per-turn SDK usage.
        </p>
      )}
      {local ? (
        // Always-real local spend, summed over the per-turn telemetry rows
        // (§24.34) — present even when Portkey is unavailable. cost_cents is an
        // SDK estimate (not billing; Portkey is the calibrated source when
        // connected). Wall-clock-windowed → `live-volatile` so the visual
        // baseline masks it; the value is covered by the unit + E2E tests.
        <div
          data-testid="live-volatile"
          className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 font-mono text-[11px] text-muted-foreground"
        >
          <span data-testid="local-spend">${(local.turn_cost_cents_total / 100).toFixed(2)} est</span>
          <span>
            {local.turns_total} turn{local.turns_total === 1 ? '' : 's'}
          </span>
        </div>
      ) : null}
    </Panel>
  )
}

/** RECENT OUTCOMES — the most-recently-active applications with current stage +
 * the ◆ public marker, from the already-polled funnel rows. An honest
 * current-state snapshot; true transition arrows need the deferred
 * funnel_events history (§24.29). */
export function RecentOutcomesPanel({ apps }: { apps: FunnelApplication[] }) {
  const recent = apps
    .filter((a) => a.last_activity_at != null)
    .slice()
    .sort((a, b) => (b.last_activity_at as string).localeCompare(a.last_activity_at as string))
    .slice(0, 6)
  return (
    <Panel title="Recent outcomes">
      {recent.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <ol data-testid="recent-outcomes" className="flex flex-col gap-1.5 font-mono text-xs">
          {recent.map((a) => {
            const isPublic = a.public_state === 'public'
            return (
              <li key={a.application_ref} className="flex items-center justify-between gap-2">
                <span className="truncate text-foreground">
                  {isPublic ? a.application_ref : `[${a.application_ref}]`}
                </span>
                <span className="flex items-center gap-2">
                  <span className="uppercase tracking-wider text-muted-foreground">{a.stage}</span>
                  {isPublic ? <span className="text-primary">◆</span> : null}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
