import { cn } from '~/lib/utils'
import type { SimRunStatus, SimTraceEvent } from '~/lib/use-simulator-run'

/**
 * The simulator run's live ACTIVITY pane (PORTAL §5.3, left pane). Renders the
 * real per-run trace wire (`sdkMessageToTraceEvents` → `/api/simulator/:id/stream`):
 * one line per `tool` / `subagent` dispatch (with its `input_summary`), nested a
 * level when it ran inside a subagent (`parent_tool_use_id`), a `▸` step marker,
 * and a single run-level completion line carrying the one end-of-run
 * `result.cost_usd` — the wire emits no per-subagent cost/latency, so none is
 * shown (never fabricated). Shares the `/live` terminal/mono visual register;
 * reduced-motion-safe (the running dot pulses via CSS only).
 */
export function SimActivity({
  trace,
  status,
  cost_usd,
}: {
  trace: SimTraceEvent[]
  status: SimRunStatus
  cost_usd: number | null
}) {
  const running = status === 'running' || status === 'starting'
  const done = status === 'done'

  return (
    <section
      aria-labelledby="sim-activity-heading"
      data-testid="sim-activity"
      className="flex h-full flex-col rounded-lg border border-border bg-card"
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
        </span>
      </header>

      <div className="min-h-0 flex-1">
        {trace.length === 0 ? (
          <p data-testid="sim-activity-empty" className="px-4 py-6 font-mono text-xs text-muted-foreground">
            {running ? 'starting sandbox session…' : 'The run trace will appear here.'}
          </p>
        ) : (
          <ol
            data-testid="sim-activity-lines"
            className="max-h-[26rem] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
          >
            {trace.map((ev, i) => {
              const nested = ev.parent_tool_use_id != null
              const label = ev.t === 'subagent' ? (ev.subagent ?? 'subagent') : (ev.name ?? 'tool')
              return (
                <li
                  key={i}
                  data-testid={ev.t === 'subagent' ? 'sim-trace-subagent' : 'sim-trace-tool'}
                  className={cn('flex flex-wrap items-baseline gap-x-2 py-0.5', nested && 'pl-5')}
                >
                  <span className="text-muted-foreground">▸</span>
                  <span className={ev.t === 'subagent' ? 'text-primary' : 'text-accent-cool'}>{label}</span>
                  {ev.input_summary ? (
                    <span className="min-w-0 flex-1 text-muted-foreground">{ev.input_summary}</span>
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
      </div>
    </section>
  )
}
