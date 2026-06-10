import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { LiveCursor, StateNote } from '~/components/states'
import type { StreamStatus } from '~/lib/sse'
import { eventSourceLabel, type AuditEvent } from '~/lib/use-activity-stream'

/**
 * The ticker clock (§24.57): today's events render `HH:MM`; an event from a
 * previous local day swaps in its date — `«Mon D» HH:MM` — in the same slot.
 * The ticker can't afford divider rows (it's a 5-line teaser), so the day
 * rides the clock; width stays phone-safe.
 */
function tickerClock(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`
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
      {/* Reserve the feed's 5-row capacity so the connecting/empty message and the
          populated list occupy the same height — the box doesn't grow when events
          arrive (the §24.36 dimensional-stability standard). 5 rows of text-sm
          (1.25rem line) + 4 × space-y-1 (0.25rem) = 7.25rem. */}
      <div className="min-h-[7.25rem]">
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
                <span className="whitespace-nowrap tabular-nums text-muted-foreground">{tickerClock(e.ts)}</span>
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
                {/* [ref] + summary are one unit: on a phone the group drops to its
                  own full-width line, the ref leading the message, clamped to 2
                  lines so one long action can't swallow the 5-line teaser (§24.37);
                  desktop keeps the single-line truncating terminal row. mr-2 matches
                  the row's gap-x-2 so desktop is unchanged. */}
                <span className="line-clamp-2 w-full min-w-0 sm:line-clamp-none sm:block sm:w-auto sm:flex-1 sm:truncate">
                  {/* [ref] deep-links into that application's /pipeline drawer
                      (§24.60) — dotted underline as the touch-visible affordance. */}
                  {e.application_ref ? (
                    <Link
                      to="/pipeline"
                      search={{ app: e.application_ref }}
                      data-testid="ticker-ref-link"
                      className="mr-2 text-muted-foreground underline decoration-muted-foreground/50 decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      [{e.application_ref}]
                    </Link>
                  ) : null}
                  <span className="text-foreground">{e.summary}</span>
                </span>
                {e.model_used ? <span className="text-muted-foreground">{e.model_used}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
