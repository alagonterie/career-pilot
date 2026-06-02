import * as React from 'react'

import { LiveIndicator } from '~/components/LiveIndicator'
import type { StreamStatus } from '~/lib/sse'
import type { AuditEvent } from '~/lib/use-activity-stream'

function clock(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

interface Chip {
  id: string
  label: string
  match: (e: AuditEvent) => boolean
}

// Data-driven filter chips (PORTAL §5.2). Reactive/Proactive read the real
// `proactive` flag; the per-subagent + System chips read `agent_name`/`category`.
const AGENT_CHIPS: { agent: string; label: string }[] = [
  { agent: 'research-company', label: 'Research' },
  { agent: 'tailor-resume', label: 'Tailor' },
  { agent: 'draft-outreach', label: 'Outreach' },
  { agent: 'prep-interview', label: 'Prep' },
  { agent: 'scrape-jobs', label: 'Scrape' },
  { agent: 'funnel-curator', label: 'Curator' },
]

const CHIPS: Chip[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'reactive', label: 'Reactive', match: (e) => !e.proactive },
  { id: 'proactive', label: 'Proactive', match: (e) => !!e.proactive },
  ...AGENT_CHIPS.map((c) => ({ id: c.agent, label: c.label, match: (e: AuditEvent) => e.agent_name === c.agent })),
  { id: 'system', label: 'System', match: (e) => e.agent_name == null },
]

/** A progressive metric lane — rendered by the caller only when its value exists. */
function Lane({ children, title, tone }: { children: React.ReactNode; title: string; tone?: string }) {
  return (
    <span className={tone ?? 'text-muted-foreground'} title={title}>
      {children}
    </span>
  )
}

/**
 * The /live trace-stream centerpiece (PORTAL §5.2): a fuller LogStream over the
 * same SSE feed as the landing ticker. Terminal-style append (newest at the
 * bottom — PORTAL §3.5), auto-scroll with a Slack-style "jump to live" button
 * when the visitor scrolls up, data-driven filter chips, and the per-line metric
 * lanes rendered progressively (the §24.24 honesty rule — a lane appears only
 * when the row carries it; nothing is ever faked). Reduced-motion-safe (no
 * smooth scroll — discrete jumps, like a real terminal).
 */
export function LogStream({
  events,
  status,
  count,
}: {
  events: AuditEvent[]
  status: StreamStatus | 'idle'
  count: number
}) {
  const [active, setActive] = React.useState('all')
  const [stuck, setStuck] = React.useState(true)
  const scrollRef = React.useRef<HTMLOListElement>(null)

  const chip = CHIPS.find((c) => c.id === active) ?? CHIPS[0]
  const filtered = events.filter(chip.match)

  // Auto-scroll to the newest line while the visitor is "stuck" to the bottom.
  React.useEffect(() => {
    if (stuck && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [filtered.length, stuck])

  const onScroll = (e: React.UIEvent<HTMLOListElement>): void => {
    const el = e.currentTarget
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  const jumpToLive = (): void => {
    setStuck(true)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }

  return (
    <section
      aria-labelledby="trace-heading"
      data-testid="trace-stream"
      className="flex h-full flex-col rounded-lg border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 id="trace-heading" className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Agent trace stream
        </h2>
        <LiveIndicator status={status} count={count} />
      </header>

      <div
        role="group"
        aria-label="Filter the trace stream"
        className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2"
      >
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={active === c.id}
            data-testid={`trace-chip-${c.id}`}
            onClick={() => setActive(c.id)}
            className={[
              'rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active === c.id
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="relative min-h-0 flex-1">
        {filtered.length === 0 ? (
          <p data-testid="trace-empty" className="px-4 py-6 font-mono text-sm text-muted-foreground">
            {events.length === 0
              ? status === 'reconnecting'
                ? 'Activity stream offline — reconnecting…'
                : 'Agents warming up…'
              : 'No events match this filter.'}
          </p>
        ) : (
          <ol
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="trace-lines"
            className="max-h-[28rem] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
          >
            {filtered.map((e) => (
              <li key={e.seq} data-testid="trace-line" className="flex flex-wrap items-baseline gap-x-2 py-0.5">
                <span className="tabular-nums text-muted-foreground">{clock(e.ts)}</span>
                <span className="text-accent-cool">{e.agent_name ?? e.category}</span>
                {e.proactive ? (
                  <span
                    data-testid="trace-proactive"
                    className="text-primary"
                    title="proactive — the agent initiated this on its own"
                  >
                    ◆
                  </span>
                ) : null}
                {e.application_ref ? <span className="text-muted-foreground">[{e.application_ref}]</span> : null}
                <span className="min-w-0 flex-1 text-foreground">{e.summary}</span>
                {/* progressive metric lanes — present only when captured (§24.24) */}
                {e.model_used ? <Lane title="model">{e.model_used}</Lane> : null}
                {e.tokens != null ? <Lane title="tokens">{e.tokens.toLocaleString()} tok</Lane> : null}
                {e.latency_ms != null ? <Lane title="latency">{(e.latency_ms / 1000).toFixed(1)}s</Lane> : null}
                {e.cost_cents != null ? <Lane title="cost">${(e.cost_cents / 100).toFixed(3)}</Lane> : null}
                {e.cache_hit ? (
                  <Lane title="cache hit" tone="text-primary">
                    cache✓
                  </Lane>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {!stuck && filtered.length > 0 ? (
          <button
            type="button"
            data-testid="trace-jump"
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
