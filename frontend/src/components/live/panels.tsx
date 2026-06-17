import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { InfoTip } from '~/components/InfoTip'
import { MultiSparkline } from '~/components/Sparkline'
import { ModeBanner } from '~/components/architecture/ModeBanner'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { PipelineApplication } from '~/lib/use-pipeline'
import type { Observability, TrafficClass } from '~/lib/use-observability'
import type { PollStatus } from '~/lib/use-polled-json'
import type { TelemetryView } from '~/lib/use-telemetry'

/** Loading twin for a panel body (§24.36 36.1) — a couple of metric-sized
 * skeletons so the panel keeps its shape while its endpoint is polled. Rail
 * panels (`My Job Pipeline`, `Recent outcomes`) carry a `min-h` sized to their MAX
 * loaded footprint, so loading→ok reserves the same height and the trace stream
 * beside them (which is `h-full`, sized by the rail) doesn't collapse — the
 * §24.36 Tier-2 stability standard. */
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
 * the §24.57 explain-on-tap affordance for metric jargon. The label never
 * wraps (§24.62): in a narrow grid column the ⓘ pushed "turn p50" onto two
 * lines — a label that can't fit its column gets a shorter label, not a wrap. */
function Metric({
  value,
  label,
  testId,
  info,
  align = 'left',
}: {
  value: string
  label: string
  testId?: string
  info?: ReactNode
  // `right` mirrors the tile to the box's right edge (the §24.84 two-amount
  // bookend); every existing call omits it and stays left-aligned.
  align?: 'left' | 'right'
}) {
  return (
    <div className={align === 'right' ? 'flex flex-col items-end text-right' : 'flex flex-col'}>
      <span data-testid={testId} className="font-mono text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className="whitespace-nowrap">{label}</span>
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

/** SYSTEM STATUS — the mode banner (live/shadow + agent-state, each with an
 * explain-on-tap InfoTip), rendered UNBOXED as a header strip (it's page-level
 * status, not a stat tile — §24.69 follow-up). The old "backend online" dot was
 * dropped: it was hardcoded `online` and could never read otherwise (a down
 * backend renders the `error` branch below instead), so it was tautological. */
export function SystemStatusStrip({ mode, status }: { mode: SystemMode | null; status?: PollStatus }) {
  if (status === 'error') {
    return (
      <div data-testid="system-status">
        <StateNote tone="error" className="text-xs">
          Offline — retrying…
        </StateNote>
      </div>
    )
  }
  // ModeBanner owns the loading skeleton too (same fixed chip geometry), so
  // loading→loaded is shift-free.
  return (
    <div data-testid="system-status">
      <ModeBanner mode={mode} loading={status === 'loading'} />
    </div>
  )
}

/** ACTIVE SESSIONS — live counts from /api/architecture (the 24h history chart
 * needs a series endpoint → deferred). §24.62: the thinnest panel gets the
 * explain-on-tap treatment (what a session IS) + the siblings' footer line —
 * no invented metrics; the endpoint exposes only the two counts. */
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
        <>
          <div className="flex items-end gap-6">
            <Metric
              value={running != null ? String(running) : '—'}
              label="running"
              info="Sessions with a live container right now. Containers idle out between turns and respawn on the next message, so fewer running than active is normal."
            />
            <Metric
              value={active != null ? String(active) : '—'}
              label="active"
              info="Open conversation threads — the owner's chat, scheduled jobs, the public sandbox runs — each an isolated session with its own container and history."
            />
          </div>
          <p className="border-t border-border pt-2 font-mono text-[11px] text-muted-foreground">
            1 session = 1 conversation in its own container
          </p>
        </>
      )}
    </Panel>
  )
}

/** Shared traffic-class colors (§24.110) — the single source the LLM-spend legend
 *  (SPEND_CLASSES) and the container-pool memory bar both draw from, so a class
 *  reads the same color everywhere. `dot` is the bar/legend fill; `line` the
 *  chart-line text color. */
const CLASS_META = {
  chat: { label: 'chat', dot: 'bg-primary', line: 'text-primary' },
  ops: { label: 'ops', dot: 'bg-accent-cool', line: 'text-accent-cool' },
  sandbox: { label: 'sandbox', dot: 'bg-warn', line: 'text-warn' },
  host: { label: 'host', dot: 'bg-muted-foreground', line: 'text-muted-foreground' },
} satisfies Record<TrafficClass, { label: string; dot: string; line: string }>

/** Container classes (no `host` — the host process has no container), largest
 *  segment first, for the §24.110 memory-bar split. */
const CONTAINER_CLASSES = ['chat', 'ops', 'sandbox'] as const

/** CONTAINER POOL — running / capacity + a memory-utilization readout, reusing
 * 7.2's /api/architecture container shape. The memory bar is segmented by traffic
 * class (§24.110) when the backend supplies `by_class`. */
export function ContainerPoolPanel({ arch, status }: { arch: ArchitectureData | null; status?: PollStatus }) {
  const c = arch?.containers
  const running = c?.running ?? null
  const cap = c?.capacity_max ?? null
  const down = c?.runtime === 'down'
  const pct = c && running != null && cap ? Math.round((running / cap) * 100) : 0
  const memUsed = c && running != null ? running * c.memory_mb_each : null
  // §24.110: running containers split by traffic class — largest segment first
  // (leftmost). The segments fill the SAME running/cap width the single bar did,
  // split by each class's share, so the bar total still equals the headline.
  const byClass = c?.by_class
  const segments = byClass
    ? CONTAINER_CLASSES.map((key) => ({ key, count: byClass[key] }))
        .filter((s) => s.count > 0)
        .sort((a, b) => b.count - a.count)
    : []
  const segSum = segments.reduce((sum, s) => sum + s.count, 0)
  // Explain-on-tap (§24.95): the on-demand model (0 at rest is healthy) + the
  // now-enforced concurrency ceiling (§24.92) + the graceful queue + the §24.110
  // per-source color split. Built from the live cap/memory when present.
  const poolInfo =
    cap != null
      ? `Agent containers spin up on demand and stop when idle — 0 running at rest is normal. Capped at ${cap} concurrent (×${c?.memory_mb_each ?? 512} MB) to protect the host; extra runs queue briefly until a slot frees. The bar is colored by what each container is doing — owner chat, autonomous ops, public sandbox.`
      : 'Agent containers spin up on demand and stop when idle — 0 running at rest is normal. The pool is capped to protect the host; extra runs queue briefly until a slot frees.'
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
        info={poolInfo}
      />
      {c && !down ? (
        <div className="flex flex-col gap-1">
          <div
            className="flex h-1.5 overflow-hidden rounded-full bg-secondary"
            aria-hidden="true"
            data-testid="pool-mem-bar"
          >
            {segSum > 0 ? (
              segments.map((s) => (
                <div
                  key={s.key}
                  title={`${CLASS_META[s.key].label} · ${s.count} running`}
                  className={`h-full ${CLASS_META[s.key].dot}`}
                  style={{ width: `${(s.count / segSum) * pct}%` }}
                />
              ))
            ) : (
              // No per-class data (older backend) or nothing classified yet → the
              // honest single bar, same as before.
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            )}
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            {memUsed != null ? `${memUsed} MB` : '—'} used · {c.memory_mb_each} MB each
          </span>
        </div>
      ) : null}
    </Panel>
  )
}

/** LLM TELEMETRY — the performance box (§24.34/§24.47): turn count + latency
 * p50/p95 + top model, from the local per-turn capture; the always-real local
 * activity aggregates render unconditionally. (Cache rate lives with cost in the
 * LLM spend box — it's a cost lever, not a perf metric — §24.69 follow-up.)
 * Honest labels — "turns" (not raw gateway requests), "turn p50/p95" (whole turn). */
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
          {/* Content-sized flex, not grid-cols-3 (§24.62): Tailwind's 1fr tracks
              are minmax(0,1fr), so at narrow rail widths the nowrap "turn p50"
              label overflowed its track into the neighbor. Flex lets each metric
              take its natural width and wraps as the graceful worst case. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
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
          <span>{local.simulator_runs_total} sandbox runs</span>
        </div>
      ) : null}
    </Panel>
  )
}

/** Friendly labels + a distinct color per traffic class (§24.69). `line` (a
 * `text-*` class) drives the overlaid chart line via currentColor; `dot` (a
 * `bg-*` class) is the legend swatch. Both are spelled out as LITERALS — Tailwind
 * only emits utilities it sees verbatim in source, so a derived `'text-'→'bg-'`
 * replace silently dropped the accent-cool dot. None is `destructive` (spend
 * isn't an alarm). */
const SPEND_CLASS_DESCS: Record<TrafficClass, string> = {
  chat: 'Owner chats — model calls from the candidate’s Telegram conversations with the orchestrator.',
  ops: 'Autonomous ops — the scheduled jobs running on their own (morning briefing, pipeline sweep, job scouting).',
  sandbox: 'Public sandbox — “Watch it work” runs by visitors, each isolated and budget-capped.',
  host: 'Host processing — the host’s own model calls (the sanitizer’s semantic pass, win-confidence scoring), not a container.',
}

/** The LLM-spend legend classes — colors from the shared CLASS_META (§24.110), in
 *  display order (host last; it has no container, so the memory bar omits it). */
const SPEND_CLASSES: { key: TrafficClass; short: string; line: string; dot: string; desc: string }[] = (
  ['chat', 'ops', 'sandbox', 'host'] as TrafficClass[]
).map((key) => ({
  key,
  short: CLASS_META[key].label,
  line: CLASS_META[key].line,
  dot: CLASS_META[key].dot,
  desc: SPEND_CLASS_DESCS[key],
}))

/** Format microUSD as dollars — sub-cent figures (most rows) keep 4 decimals so
 * they don't all collapse to "$0.00"; anything ≥ 1¢ shows the familiar 2. */
function fmtUsd(microusd: number): string {
  const usd = microusd / 1_000_000
  return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

/** LLM SPEND — the cost box (§24.69; replaces the old Cost & cache + the
 * full-width Spend-by-class strip). A stat tile equal to LLM telemetry beside
 * it: a 24h total headline + the cache rate (which is a cost lever, so it lives
 * with cost), then ONE overlaid multi-line chart (a colored line per class on a
 * shared scale — a taller line spent more) and a color legend carrying each
 * class's total. Spend is a single source (request_telemetry via
 * /api/observability) — the comprehensive one, the only place host-side spend
 * (sim prose, sanitizer) shows; `cacheHitRate` rides in from the per-turn
 * telemetry (`view.local`). Aggregate-only; no per-request data. */
export function LlmSpendPanel({
  data,
  cacheHitRate,
  status,
}: {
  data: Observability | null
  cacheHitRate?: number | null
  status?: PollStatus
}) {
  if (status === 'loading') {
    return (
      <Panel title="LLM spend">
        <PanelSkeleton lines={2} />
      </Panel>
    )
  }
  if (status === 'error') {
    return (
      <Panel title="LLM spend">
        <PanelOffline />
      </Panel>
    )
  }
  const spend = data?.spend_by_class ?? null
  const total = spend ? SPEND_CLASSES.reduce((sum, c) => sum + spend[c.key].microusd_24h, 0) : 0
  return (
    <Panel title="LLM spend">
      {spend == null ? (
        <PanelSkeleton lines={2} />
      ) : total === 0 ? (
        <p data-testid="spend-pending" className="font-mono text-xs text-muted-foreground">
          No LLM spend captured in the last 24h. Owner chat, autonomous ops, the public sandbox, and host processing
          each get a line as requests land.
        </p>
      ) : (
        <div data-testid="spend-by-class" className="flex flex-col gap-2">
          {/* Two equally-styled amounts, bookended (§24.84): 24h spend (left) +
              cache rate (right; a cost lever, so it lives with cost). Same big-number
              Metric, side by side on one row — the cache adds no height, so the tile
              still fits the stat-row 196px floor and the four boxes stay uniform. */}
          <div className="flex items-start justify-between gap-2">
            <Metric
              testId="llm-spend-total"
              value={fmtUsd(total)}
              label="24h · est"
              info={
                <>
                  Every model call&apos;s cost from our own telemetry, summed over the last 24 h and split by who
                  triggered it — owner chat, the autonomous schedules, public sandbox visitors, host processing. This
                  page costs the candidate roughly {fmtUsd(total)}/day to run — an estimate from list prices, not a
                  bill.
                </>
              }
            />
            {cacheHitRate != null ? (
              <Metric
                testId="llm-cache-rate"
                align="right"
                value={`${Math.round(cacheHitRate * 100)}%`}
                label="cache"
                info={
                  <>
                    Prompt caching re-serves unchanged context (the agent&apos;s instructions, tools, history) instead
                    of reprocessing it — cached tokens cost about a tenth of fresh ones. It&apos;s why the spend is as
                    low as it is; higher is cheaper.
                  </>
                }
              />
            ) : null}
          </div>
          <div data-testid="spend-chart">
            <MultiSparkline
              height={24}
              series={SPEND_CLASSES.map((c) => ({ values: spend[c.key].buckets, className: c.line }))}
            />
          </div>
          {/* Compact 2-column legend (color → short class → 24h total) so the tile
              fits the stat-row floor; the total's InfoTip spells out the classes. */}
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
            {SPEND_CLASSES.map((c) => (
              <li
                key={c.key}
                title={c.desc}
                className="inline-flex cursor-help items-center gap-1.5 font-mono text-[10px]"
              >
                <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${c.dot}`} />
                <span className="uppercase tracking-widest text-muted-foreground">{c.short}</span>
                <span data-testid={`spend-${c.key}`} className="ml-auto tabular-nums text-foreground">
                  {fmtUsd(spend[c.key].microusd_24h)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/** RECENT OUTCOMES — the most-recently-active applications with current stage +
 * the ◆ public marker, from the already-polled pipeline rows. An honest
 * current-state snapshot; true transition arrows need the deferred
 * funnel_events history (§24.29). `flex-1` lets it grow to fill the rail down to
 * the trace-stream height beside it (§24.69 follow-up) — the list earns the room
 * by showing more of the real recent activity, rather than leaving a dead gap. */
/** Color ONLY the outcome word (§24.109 #12), never the company ref: a win and a
 *  loss should be scannable at a glance. Terminal outcomes get tone; in-progress
 *  stages stay muted (they're not an outcome yet). Pure + keyed on the lowercase
 *  stage vocabulary (use-pipeline). */
export function outcomeToneClass(stage: string): string {
  switch (stage.toLowerCase()) {
    case 'offer':
      return 'text-primary'
    case 'rejected':
      return 'text-destructive'
    case 'withdrawn':
      return 'text-muted-foreground/70'
    default:
      return 'text-muted-foreground'
  }
}

export function RecentOutcomesPanel({ apps, status }: { apps: PipelineApplication[]; status?: PollStatus }) {
  const recent = apps
    .filter((a) => a.last_activity_at != null)
    .slice()
    .sort((a, b) => (b.last_activity_at as string).localeCompare(a.last_activity_at as string))
    .slice(0, 8)
  if (status === 'loading') {
    return (
      <Panel title="Recent outcomes" className="flex-1 min-h-[188px]">
        <PanelSkeleton lines={3} />
      </Panel>
    )
  }
  if (status === 'error') {
    return (
      <Panel title="Recent outcomes" className="flex-1 min-h-[188px]">
        <PanelOffline />
      </Panel>
    )
  }
  return (
    <Panel title="Recent outcomes" className="flex-1 min-h-[188px]">
      {recent.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <ol data-testid="recent-outcomes" className="flex flex-col gap-1.5 font-mono text-xs">
          {/* Each row deep-links into the /pipeline drawer for that application
              (§24.57) — the static outcome list becomes navigation into the
              detail panel that already exists there. */}
          {recent.map((a) => {
            const isPublic = a.public_state === 'public'
            return (
              // keyed by application_id, not the ref — two PUBLIC applications
              // at one company share their company-name ref (§24.62 note)
              <li key={a.application_id}>
                <Link
                  to="/pipeline"
                  search={{ app: a.application_ref }}
                  data-testid="recent-outcome-link"
                  className="group flex items-center justify-between gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-foreground group-hover:underline">
                    {isPublic ? a.application_ref : `[${a.application_ref}]`}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`uppercase tracking-wider ${outcomeToneClass(a.stage)}`}>{a.stage}</span>
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
