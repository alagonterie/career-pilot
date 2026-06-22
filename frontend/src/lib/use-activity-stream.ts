import * as React from 'react'

import { useSurfaceState } from './dev-state'
import { connectActivityStream, type StreamStatus } from './sse'

/**
 * A sanitized public_audit_trail row as delivered over /api/activity[/stream].
 * The telemetry lanes (model/tokens/cost/cache/latency) are nullable — carried
 * by `category='turn'` rows (§24.34 per-turn capture), rendered only when
 * present (progressive). `cache_read_pct` is the quantitative cache lane
 * (§24.55: share of prompt tokens served from cache, 0–100); `cache_hit` is the
 * legacy boolean — still delivered, no longer rendered (it was always true).
 */
export interface AuditEvent {
  seq: number
  ts: string
  category: string
  agent_name: string | null
  proactive: number
  application_ref: string | null
  model_used: string | null
  tokens: number | null
  cost_cents: number | null
  cache_hit: number | null
  cache_read_pct: number | null
  latency_ms: number | null
  summary: string
}

export interface ActivityStreamState {
  events: AuditEvent[]
  status: StreamStatus | 'idle'
  count: number
}

export interface ActivityStreamOptions {
  /** Keep only the most recent N events, applied *after* `exclude`. Default 5. */
  limit?: number
  /**
   * Categories to drop at ingestion (before the cap), so the kept window isn't
   * spent on rows this consumer never shows. The compact home ticker passes
   * `['turn']`: turns are the /live cost story (§24.35 Pass C), and without this
   * a stretch of consecutive turns would consume the whole 5-row window and
   * blank the ticker even while real actions sit just behind them.
   */
  exclude?: string[]
}

/**
 * The visitor-facing source label for an event (the subagent name, else the
 * category). No mapping layer: the public audit data is natively visitor-facing
 * — migration 137 (§24.77 D3) rewrote the legacy `'pipeline'` category → `'pipeline'`
 * and the `'pipeline-scribe'` agent_name → `'pipeline-scribe'`, so a raw row
 * already reads right and nothing says "pipeline" on the public surface.
 */
export function eventSourceLabel(e: AuditEvent): string {
  return e.agent_name ?? e.category
}

/**
 * §24.116: the fixed host-emitted summary on a deterministic §24.78 subagent
 * dispatch row (mirrors `SUBAGENT_DISPATCH_SUMMARY` in the host's actions.ts).
 * It is a PII-free constant the host controls — never model text — so the FE can
 * discriminate these lifecycle rows from the model's own `record_progress`
 * narration on the delivered `summary` alone, without a `details_json` round-trip
 * (which /api/activity never delivers). Pinned to the host constant by a test.
 */
export const DISPATCH_LIFECYCLE_SUMMARY = 'Dispatched by the orchestrator.'

/**
 * True for a deterministic subagent-dispatch lifecycle row (§24.116) — a SYSTEM
 * event (the orchestrator launched a subagent), which the trace stream renders
 * as a dim status marker, not as the subagent's own voice.
 */
export function isDispatchLifecycle(e: AuditEvent): boolean {
  return e.category === 'subagent_progress' && e.summary === DISPATCH_LIFECYCLE_SUMMARY
}

/**
 * Subscribe to the portal activity stream and keep the most recent `limit`
 * events (newest last). Connects with `since=0` so the ticker shows recent
 * backlog immediately, then live-tails. Client-only: SSR renders the idle
 * empty state, then the effect hydrates + connects (so the hero works with
 * JS disabled — PORTAL §10).
 *
 * Pass `exclude` to drop categories at ingestion (the home ticker excludes
 * `'turn'` so its short window isn't consumed by cost-seal rows it never shows).
 */
export function useActivityStream(baseUrl: string, opts: ActivityStreamOptions = {}): ActivityStreamState {
  const { limit = 5, exclude } = opts
  // A stable primitive dep so an inline `exclude: ['turn']` array doesn't churn
  // the effect (and reconnect) on every render.
  const excludeKey = exclude && exclude.length > 0 ? exclude.join(',') : ''
  const [events, setEvents] = React.useState<AuditEvent[]>([])
  const [status, setStatus] = React.useState<StreamStatus | 'idle'>('idle')
  const [count, setCount] = React.useState(0)
  const forced = useSurfaceState('activity')

  React.useEffect(() => {
    const ac = new AbortController()
    const seen = new Set<number>()
    const excluded = excludeKey ? new Set(excludeKey.split(',')) : null
    // Clean transition when the override flips (the dev switcher): clear the
    // ring buffer + reset status so the new state renders fresh, not stacked on
    // the prior connection's events.
    setEvents([])
    setStatus('idle')
    setCount(0)
    void connectActivityStream({
      baseUrl,
      since: 0,
      stateParam: forced === 'normal' ? undefined : forced,
      signal: ac.signal,
      onStatus: setStatus,
      onEvent: (ev) => {
        let row: AuditEvent
        try {
          row = JSON.parse(ev.data) as AuditEvent
        } catch {
          return // malformed frame — skip
        }
        if (typeof row.seq !== 'number' || seen.has(row.seq)) return // dedupe by seq
        if (excluded && excluded.has(row.category)) return // category this consumer doesn't show
        seen.add(row.seq)
        setCount((c) => c + 1)
        setEvents((prev) => [...prev, row].slice(-limit))
      },
    })
    return () => ac.abort()
  }, [baseUrl, limit, excludeKey, forced])

  return { events, status, count }
}
