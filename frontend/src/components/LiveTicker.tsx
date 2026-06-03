import type { ReactNode } from 'react'

import { LiveCursor, StateNote } from '~/components/states'
import type { StreamStatus } from '~/lib/sse'
import { eventSourceLabel, type AuditEvent } from '~/lib/use-activity-stream'

function hhmm(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Compact live activity ticker (PORTAL §5.1 Viewport 3). Monospace, last-N
 * ring buffer (the hook caps it), older lines faded. Rendering is progressive
 * (§24.24): `agent_name` / `◆ proactive` / `application_ref` are live today;
 * model + cache-hit lanes appear only once a later capture phase populates
 * them. A missing field is simply absent — never faked.
 */
export function LiveTicker({
  events,
  status,
  action,
}: {
  events: AuditEvent[]
  status: StreamStatus | 'idle'
  action?: ReactNode
}) {
  // Drop per-turn cost-summary rows (§24.35 Pass C): they're the /live trace
  // stream's story (rendered there as a batch-sealing separator); on this
  // 5-line teaser they're noise. The ticker shows the action events.
  const shown = events.filter((e) => e.category !== 'turn')
  return (
    <section
      id="live-ticker"
      aria-labelledby="ticker-heading"
      data-testid="live-ticker"
      className="mx-auto mt-16 w-full max-w-2xl rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="ticker-heading" className="text-sm font-semibold text-muted-foreground">
          Live activity
        </h2>
        {action}
      </div>
      {shown.length === 0 ? (
        status === 'reconnecting' ? (
          <StateNote data-testid="ticker-empty" tone="error">
            Activity stream offline — reconnecting…
          </StateNote>
        ) : status === 'open' ? (
          <StateNote data-testid="ticker-empty">No agent activity yet.</StateNote>
        ) : (
          <p data-testid="ticker-empty" className="flex items-center gap-1 font-mono text-sm text-muted-foreground">
            Connecting to the live feed
            <LiveCursor />
          </p>
        )
      ) : (
        <ol className="space-y-1 font-mono text-sm">
          {/* No opacity-fade for older lines: opacity blending drops text below
              WCAG AA on the near-black card (axe-verified). Newest row sits at
              the bottom — that ordering is the hierarchy. */}
          {shown.map((e) => (
            <li key={e.seq} data-testid="ticker-row" className="flex flex-wrap items-center gap-x-2">
              <span className="tabular-nums text-muted-foreground">{hhmm(e.ts)}</span>
              <span className="text-accent-cool">{eventSourceLabel(e)}</span>
              {e.proactive ? (
                <span
                  data-testid="proactive-marker"
                  className="text-primary"
                  title="proactive — the agent initiated this on its own"
                >
                  ◆ proactive
                </span>
              ) : null}
              {e.application_ref ? <span className="text-muted-foreground">[{e.application_ref}]</span> : null}
              <span className="min-w-0 flex-1 truncate text-foreground">{e.summary}</span>
              {e.model_used ? <span className="text-muted-foreground">{e.model_used}</span> : null}
              {e.cache_hit ? <span className="text-muted-foreground">(cache hit)</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
