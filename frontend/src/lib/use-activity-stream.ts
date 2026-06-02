import * as React from 'react'

import { connectActivityStream, type StreamStatus } from './sse'

/**
 * A sanitized public_audit_trail row as delivered over /api/activity[/stream].
 * Telemetry fields are nullable — populated by a later capture phase (§24.24);
 * the ticker renders them only when present (progressive enhancement).
 */
export interface AuditEvent {
  seq: number
  ts: string
  category: string
  agent_name: string | null
  proactive: number
  application_ref: string | null
  model_used: string | null
  cache_hit: number | null
  summary: string
}

export interface ActivityStreamState {
  events: AuditEvent[]
  status: StreamStatus | 'idle'
  count: number
}

/**
 * Subscribe to the portal activity stream and keep the most recent `limit`
 * events (newest last). Connects with `since=0` so the ticker shows recent
 * backlog immediately, then live-tails. Client-only: SSR renders the idle
 * empty state, then the effect hydrates + connects (so the hero works with
 * JS disabled — PORTAL §10).
 */
export function useActivityStream(baseUrl: string, limit = 5): ActivityStreamState {
  const [events, setEvents] = React.useState<AuditEvent[]>([])
  const [status, setStatus] = React.useState<StreamStatus | 'idle'>('idle')
  const [count, setCount] = React.useState(0)

  React.useEffect(() => {
    const ac = new AbortController()
    const seen = new Set<number>()
    void connectActivityStream({
      baseUrl,
      since: 0,
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
        seen.add(row.seq)
        setCount((c) => c + 1)
        setEvents((prev) => [...prev, row].slice(-limit))
      },
    })
    return () => ac.abort()
  }, [baseUrl, limit])

  return { events, status, count }
}
