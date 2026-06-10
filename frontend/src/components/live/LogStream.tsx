import { useReducedMotion } from 'motion/react'
import * as React from 'react'

import { InfoTip } from '~/components/InfoTip'
import { LiveIndicator } from '~/components/LiveIndicator'
import { LiveCursor, StateNote } from '~/components/states'
import type { StreamStatus } from '~/lib/sse'
import { eventSourceLabel, type AuditEvent } from '~/lib/use-activity-stream'

function clock(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** A render row: an event, or a day-boundary divider between events. */
type StreamRow = { kind: 'date'; key: string; label: string } | { kind: 'event'; e: AuditEvent }

/**
 * Interleave day-boundary dividers (§24.57): a divider between events from
 * different LOCAL days, plus a leading divider when the window opens on a
 * non-today date — at realistic pace the visible window spans days, and a
 * bare HH:MM:SS clock would silently lie about which day a line belongs to.
 */
function withDayDividers(events: AuditEvent[]): StreamRow[] {
  const out: StreamRow[] = []
  let prevDay: string | null = null
  const todayKey = new Date().toDateString()
  for (const e of events) {
    const d = new Date(e.ts)
    const day = Number.isNaN(d.getTime()) ? null : d.toDateString()
    if (day && day !== prevDay && (prevDay !== null || day !== todayKey)) {
      out.push({
        kind: 'date',
        key: `date-${day}`,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      })
    }
    if (day) prevDay = day
    out.push({ kind: 'event', e })
  }
  return out
}

interface Chip {
  id: string
  label: string
  match: (e: AuditEvent) => boolean
}

// Data-driven filter chips (PORTAL §5.2). Reactive/Proactive read the real
// `proactive` flag; the per-subagent + System chips read `agent_name`/`category`.
// Each chip matches an id LIST (§24.59): the audit trail is append-only, so
// historical rows keep pre-rename agent ids ('funnel-curator' → pipeline-scribe,
// 'prep-interview' → build-interview-kit) and one chip covers old + new.
const AGENT_CHIPS: { id: string; agents: string[]; label: string }[] = [
  { id: 'research-company', agents: ['research-company'], label: 'Research' },
  { id: 'tailor-resume', agents: ['tailor-resume'], label: 'Tailor' },
  { id: 'draft-outreach', agents: ['draft-outreach'], label: 'Outreach' },
  { id: 'build-interview-kit', agents: ['build-interview-kit', 'prep-interview'], label: 'Prep' },
  { id: 'scrape-jobs', agents: ['scrape-jobs'], label: 'Scrape' },
  { id: 'pipeline-scribe', agents: ['pipeline-scribe', 'funnel-curator'], label: 'Scribe' },
]

const CHIPS: Chip[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'reactive', label: 'Reactive', match: (e) => !e.proactive },
  { id: 'proactive', label: 'Proactive', match: (e) => !!e.proactive },
  ...AGENT_CHIPS.map((c) => ({
    id: c.id,
    label: c.label,
    match: (e: AuditEvent) => e.agent_name != null && c.agents.includes(e.agent_name),
  })),
  { id: 'system', label: 'System', match: (e) => e.agent_name == null },
]

/**
 * Collapse the cost-seal `turn` rows so only the ones that *seal something*
 * survive. A turn row is the economic seal on the action lines above it (§24.35
 * Pass C); a turn with no action lines since the previous turn seals nothing.
 * Without this, a run of consecutive bare turns — common when the orchestrator
 * answers directly or a curator sweep cheaps out — stacks as a wall of empty
 * rules (the "strange-looking activity" on /live). Order-preserving; a turn is
 * kept only when ≥1 action line has appeared since the last kept turn.
 */
function sealVisibleTurns(events: AuditEvent[]): AuditEvent[] {
  const out: AuditEvent[] = []
  let actionsSinceTurn = 0
  for (const e of events) {
    if (e.category === 'turn') {
      if (actionsSinceTurn > 0) out.push(e)
      actionsSinceTurn = 0
    } else {
      out.push(e)
      actionsSinceTurn++
    }
  }
  return out
}

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
 * when the row carries it; nothing is ever faked). A `category='turn'` row
 * renders as a batch-sealing separator (the per-turn metrics inline in a rule),
 * not a peer action line (§24.35 Pass C). Smooth-scroll when motion is allowed;
 * an instant jump under prefers-reduced-motion.
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

  const reduce = useReducedMotion()
  const chip = CHIPS.find((c) => c.id === active) ?? CHIPS[0]
  const filtered = events.filter(chip.match)
  // Drop bare/consecutive turn seals so a quiet stretch reads as quiet, not as a
  // wall of empty rules. `visible` is what actually renders (day dividers are
  // interleaved at render time — they're presentation rows, not events).
  const visible = sealVisibleTurns(filtered)
  const rows = withDayDividers(visible)
  // Key the auto-scroll on the NEWEST event's seq, not the count: the activity
  // hook caps events at `limit`, so once the ring buffer is full the length goes
  // constant and a length-keyed effect would never re-fire — auto-scroll dies.
  const newestSeq = visible.length > 0 ? visible[visible.length - 1].seq : 0

  // Stay pinned to the newest line while the visitor is "stuck" to the bottom —
  // smooth when motion is allowed, an instant jump under reduced-motion (the
  // `typeof` guard also covers jsdom, where Element.scrollTo isn't implemented).
  React.useEffect(() => {
    const el = scrollRef.current
    if (!stuck || !el) return
    if (reduce || typeof el.scrollTo !== 'function') el.scrollTop = el.scrollHeight
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [newestSeq, stuck, reduce])

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
      aria-labelledby="trace-heading"
      data-testid="trace-stream"
      className="flex h-full flex-col rounded-lg border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2
          id="trace-heading"
          className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
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
        {visible.length === 0 ? (
          filtered.length === 0 && events.length > 0 ? (
            // A chip genuinely excluded everything (vs. a window of bare turns,
            // which collapses to nothing but isn't a "no match").
            <StateNote data-testid="trace-empty" className="px-4 py-6">
              No events match this filter.
            </StateNote>
          ) : status === 'reconnecting' ? (
            <StateNote data-testid="trace-empty" tone="error" className="px-4 py-6">
              Activity stream offline — reconnecting…
            </StateNote>
          ) : status === 'open' || events.length > 0 ? (
            // Open with nothing to show, or a window of only cost-seal turns
            // (collapsed away) — either way it's a quiet-but-connected stream.
            <StateNote data-testid="trace-empty" className="px-4 py-6">
              No agent activity yet.
            </StateNote>
          ) : (
            // connecting / idle — a stream gets a terminal "connecting" affordance,
            // not a skeleton (§24.36 36.1: skeletons can't predict a stream's shape).
            <p
              data-testid="trace-empty"
              className="flex items-center gap-1 px-4 py-6 font-mono text-sm text-muted-foreground"
            >
              Connecting to the live feed
              <LiveCursor />
            </p>
          )
        ) : (
          <ol
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="trace-lines"
            className="max-h-[28rem] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
          >
            {rows.map((row) =>
              row.kind === 'date' ? (
                // A day-boundary divider (§24.57) — the realistic-pace window
                // spans days, so the stream marks where one ends.
                <li key={row.key} data-testid="trace-date" className="flex items-center gap-3 py-1.5">
                  <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground/80">{row.label}</span>
                  <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
                </li>
              ) : row.e.category === 'turn' ? (
                // A turn row is the economic seal on the actions above it (§24.35
                // Pass C) — a rule with the per-turn metrics inline, not a peer line.
                <li key={row.e.seq} data-testid="trace-turn" className="flex items-center gap-3 py-1.5">
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  <span className="flex flex-wrap items-center justify-center gap-x-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      turn
                      <InfoTip label="container turn">
                        One container turn — everything since the previous seal happened in a single agent invocation.
                        The metrics are that turn&apos;s totals: model, tokens, SDK-estimated cost, wall-clock time, and
                        the share of prompt tokens served from cache.
                      </InfoTip>
                    </span>
                    {row.e.model_used ? <span className="text-foreground/70">· {row.e.model_used}</span> : null}
                    {row.e.tokens != null ? <span>· {row.e.tokens.toLocaleString()} tok</span> : null}
                    {row.e.cost_cents != null ? <span>· ${(row.e.cost_cents / 100).toFixed(3)}</span> : null}
                    {row.e.latency_ms != null ? <span>· {(row.e.latency_ms / 1000).toFixed(1)}s</span> : null}
                    {/* quantitative cache lane (§24.55) — the share of prompt tokens
                        served from cache; the old boolean cache✓ was always true */}
                    {row.e.cache_read_pct != null ? (
                      <span className="text-primary" title="share of prompt tokens served from cache">
                        · cache {row.e.cache_read_pct}%
                      </span>
                    ) : null}
                  </span>
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </li>
              ) : (
                <li key={row.e.seq} data-testid="trace-line" className="flex flex-wrap items-baseline gap-x-2 py-0.5">
                  <span className="tabular-nums text-muted-foreground">{clock(row.e.ts)}</span>
                  <span className="text-accent-cool">{eventSourceLabel(row.e)}</span>
                  {row.e.proactive ? (
                    <span
                      data-testid="trace-proactive"
                      className="text-primary"
                      title="proactive — the agent initiated this on its own"
                    >
                      ◆
                    </span>
                  ) : null}
                  {/* [ref] + summary are one unit: on a phone the group drops to
                      its own full-width line, the ref leading the message (it's the
                      message's subject), and the message wraps fully below the
                      metadata row (§24.37); inline terminal row restored at sm+.
                      mr-2 matches the row's gap-x-2 so desktop is unchanged. */}
                  <span className="w-full min-w-0 sm:w-auto sm:flex-1">
                    {row.e.application_ref ? (
                      <span className="mr-2 text-muted-foreground">[{row.e.application_ref}]</span>
                    ) : null}
                    <span className="text-foreground">{row.e.summary}</span>
                  </span>
                  {/* progressive metric lanes — present only when captured (§24.24) */}
                  {row.e.model_used ? <Lane title="model">{row.e.model_used}</Lane> : null}
                  {row.e.tokens != null ? <Lane title="tokens">{row.e.tokens.toLocaleString()} tok</Lane> : null}
                  {row.e.latency_ms != null ? (
                    <Lane title="latency">{(row.e.latency_ms / 1000).toFixed(1)}s</Lane>
                  ) : null}
                  {row.e.cost_cents != null ? <Lane title="cost">${(row.e.cost_cents / 100).toFixed(3)}</Lane> : null}
                  {row.e.cache_read_pct != null ? (
                    <Lane title="share of prompt tokens served from cache" tone="text-primary">
                      cache {row.e.cache_read_pct}%
                    </Lane>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        )}

        {!stuck && visible.length > 0 ? (
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
