import { useReducedMotion } from 'motion/react'
import * as React from 'react'

import { humanizeTraceSummary } from '~/lib/trace-summary'
import { cn } from '~/lib/utils'
import type { SimRunStatus, SimTraceEvent } from '~/lib/use-simulator-run'

/**
 * The simulator run's live ACTIVITY pane (PORTAL §5.3, left pane). Renders the
 * real per-run trace wire (`sdkMessageToTraceEvents` → `/api/simulator/:id/stream`):
 * one line per `tool` / `subagent` dispatch with its `input_summary`
 * humanized client-side (§24.31 Δ — salient field, not raw JSON), nested a
 * level when it ran inside a subagent (`parent_tool_use_id`), a `▸` step
 * marker, and a single run-level completion line carrying the one end-of-run
 * `result.cost_usd` — the wire emits no per-subagent cost/latency, so none is
 * shown (never fabricated). Shares the `/live` register AND its finesse:
 * stuck-to-bottom auto-scroll with a "jump to live" affordance, plus a live
 * elapsed ticker while running (the honest expectation-setter — a real run
 * takes minutes). Reduced-motion-safe.
 */
export function SimActivity({
  trace,
  status,
  cost_usd,
  startedAt,
}: {
  trace: SimTraceEvent[]
  status: SimRunStatus
  cost_usd: number | null
  /** Run start (ms epoch) — drives the elapsed ticker while running. */
  startedAt?: number | null
}) {
  const running = status === 'running' || status === 'starting'
  const done = status === 'done'

  const [stuck, setStuck] = React.useState(true)
  const scrollRef = React.useRef<HTMLOListElement>(null)
  const reduce = useReducedMotion()

  // Stay pinned to the newest line while the visitor is "stuck" to the bottom
  // (the LogStream pattern) — smooth when motion is allowed, an instant jump
  // under reduced-motion; the `typeof` guard also covers jsdom.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!stuck || !el) return
    if (reduce || typeof el.scrollTo !== 'function') el.scrollTop = el.scrollHeight
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [trace.length, done, stuck, reduce])

  const onScroll = (e: React.UIEvent<HTMLOListElement>): void => {
    const el = e.currentTarget
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  const jumpToLive = (): void => {
    setStuck(true)
    const el = scrollRef.current
    if (!el) return
    if (reduce || typeof el.scrollTo !== 'function') el.scrollTop = el.scrollHeight
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  return (
    <section
      aria-labelledby="sim-activity-heading"
      data-testid="sim-activity"
      className="flex h-full min-w-0 flex-col rounded-lg border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2
          id="sim-activity-heading"
          className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Activity
        </h2>
        <span
          data-testid="sim-activity-status"
          className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-2 w-2 rounded-full',
              running ? 'bg-primary cp-live-pulse' : done ? 'bg-primary' : 'bg-muted-foreground',
            )}
          />
          {running ? 'running' : done ? 'complete' : 'idle'}
          {running && startedAt != null ? <ElapsedTicker startedAt={startedAt} /> : null}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        {trace.length === 0 ? (
          <p data-testid="sim-activity-empty" className="px-4 py-6 font-mono text-xs text-muted-foreground">
            {running ? 'starting sandbox session…' : 'The run trace will appear here.'}
          </p>
        ) : (
          <ol
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="sim-activity-lines"
            className="max-h-[26rem] overflow-y-auto overflow-x-hidden px-4 py-3 font-mono text-xs leading-relaxed"
          >
            {trace.map((ev, i) => {
              const nested = ev.parent_tool_use_id != null
              const label = ev.t === 'subagent' ? (ev.subagent ?? 'subagent') : (ev.name ?? 'tool')
              const summary = humanizeTraceSummary(ev)
              return (
                <li
                  key={i}
                  data-testid={ev.t === 'subagent' ? 'sim-trace-subagent' : 'sim-trace-tool'}
                  className={cn('flex flex-wrap items-baseline gap-x-2 py-0.5', nested && 'pl-5')}
                >
                  <span className="text-muted-foreground">▸</span>
                  <span className={ev.t === 'subagent' ? 'text-primary' : 'text-accent-cool'}>{label}</span>
                  {summary ? (
                    <span className="min-w-0 flex-1 text-muted-foreground [overflow-wrap:anywhere]">{summary}</span>
                  ) : null}
                </li>
              )
            })}
            {done ? (
              <li
                data-testid="sim-trace-complete"
                className="flex flex-wrap items-baseline gap-x-2 py-0.5 pt-2 text-foreground"
              >
                <span className="text-primary">✓</span>
                <span>run complete</span>
                {cost_usd != null ? <span className="text-muted-foreground">· ${cost_usd.toFixed(3)}</span> : null}
                <span className="text-muted-foreground">· sandbox torn down</span>
              </li>
            ) : null}
          </ol>
        )}

        {!stuck && trace.length > 0 ? (
          <button
            type="button"
            data-testid="sim-trace-jump"
            onClick={jumpToLive}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1 font-mono text-[11px] text-foreground shadow-md transition-colors hover:border-primary"
          >
            ↓ jump to live
          </button>
        ) : null}
      </div>
    </section>
  )
}

/** A 1 Hz `m:ss` elapsed readout — text-only, so reduced-motion-safe. */
function ElapsedTicker({ startedAt }: { startedAt: number }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return (
    <span data-testid="sim-elapsed" className="tabular-nums">
      · {m}:{s}
    </span>
  )
}
