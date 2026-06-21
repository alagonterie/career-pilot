import * as React from 'react'

import { connectSimulatorStream } from './sse'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

/**
 * One rich-trace step as delivered over `/api/simulator/:id/stream` (the
 * `trace` event). Mirrors the container's `TraceEvent`
 * (container/agent-runner/src/providers/types.ts): the wire emits `tool` /
 * `subagent` dispatches (with `parent_tool_use_id` for nesting) + a single
 * end-of-run `result` carrying total `cost_usd`. No per-subagent cost/latency,
 * no per-line completion — SimActivity renders dispatches + the run total.
 * The host then pushes a terminal `end` event `{ reason, cost_usd?, latency_ms }`
 * and closes the stream (STRATEGY §24.21 Δ).
 */
export interface SimTraceEvent {
  t: 'tool' | 'subagent' | 'result'
  name?: string
  subagent?: string
  parent_tool_use_id?: string | null
  input_summary?: string
  cost_usd?: number
}

export type SimRunStatus = 'idle' | 'starting' | 'running' | 'done' | 'error' | 'unavailable'

export interface SimRunInput {
  company: string
  role: string
  public_url?: string
  jd?: string
  /** Turnstile token (§24.70) — sent as the `x-turnstile-token` header, not in
   * the body; the Worker edge-guard verifies it before forwarding the run. */
  turnstileToken?: string
}

export interface SimRunState {
  status: SimRunStatus
  runId: string | null
  /** Trace dispatch steps (the `result` event is captured into `cost_usd`, not pushed here). */
  trace: SimTraceEvent[]
  /** Accumulated `chat`/`task` text — the materializing right pane. */
  output: string
  cost_usd: number | null
  elapsedMs: number | null
  /** Run start (ms epoch) while a run is active — drives the elapsed ticker. */
  startedAt: number | null
  errorMessage: string | null
  /** The run produced a downloadable tailored résumé (the gift) — set from the
   *  terminal `end` event, so the done-state can offer it without a refetch. */
  hasTailoredResume: boolean
  /** §24.146 — the structured cold-outreach email (the second gift), carried on
   *  the terminal `end` event so the done-state shows it without a refetch. */
  coldEmail: { subject: string; body: string } | null
  input: SimRunInput | null
  start: (input: SimRunInput) => void
  reset: () => void
}

/**
 * Drive a recruiter-simulator run (Sub-milestone 8.2, STRATEGY §24.31): POST
 * `/api/simulator`, then open the per-run SSE stream and accumulate the trace
 * (left pane) + output (right pane). A small state machine:
 *   idle → starting (POST) → running (SSE open) → done (terminal `end`)
 *                          ↘ unavailable (503 — disabled / no adapter)
 *                          ↘ error (network / bad response / stream drop /
 *                                   timed out with no output)
 * Client-only; the live run is ephemeral (a refresh resets — the durable
 * artifact is the `/simulator/results/:id` share page).
 */
export function useSimulatorRun(): SimRunState {
  const [status, setStatus] = React.useState<SimRunStatus>('idle')
  const [runId, setRunId] = React.useState<string | null>(null)
  const [trace, setTrace] = React.useState<SimTraceEvent[]>([])
  const [output, setOutput] = React.useState('')
  const [cost, setCost] = React.useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = React.useState<number | null>(null)
  const [startedAt, setStartedAt] = React.useState<number | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [hasTailoredResume, setHasTailoredResume] = React.useState(false)
  const [coldEmail, setColdEmail] = React.useState<{ subject: string; body: string } | null>(null)
  const [input, setInput] = React.useState<SimRunInput | null>(null)

  const acRef = React.useRef<AbortController | null>(null)
  const startedRef = React.useRef(0)
  // Mirror of `output` for the `end` handler (state would be stale in the closure).
  const outputRef = React.useRef('')

  // Abort any open stream on unmount.
  React.useEffect(() => () => acRef.current?.abort(), [])

  const reset = React.useCallback((): void => {
    acRef.current?.abort()
    acRef.current = null
    outputRef.current = ''
    setStatus('idle')
    setRunId(null)
    setTrace([])
    setOutput('')
    setCost(null)
    setElapsedMs(null)
    setStartedAt(null)
    setErrorMessage(null)
    setHasTailoredResume(false)
    setColdEmail(null)
    setInput(null)
  }, [])

  const start = React.useCallback((runInput: SimRunInput): void => {
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    outputRef.current = ''
    setStatus('starting')
    setRunId(null)
    setTrace([])
    setOutput('')
    setCost(null)
    setElapsedMs(null)
    setErrorMessage(null)
    setHasTailoredResume(false)
    setColdEmail(null)
    setInput(runInput)
    startedRef.current = Date.now()
    setStartedAt(startedRef.current)

    void (async () => {
      let id: string
      try {
        const { turnstileToken, ...payload } = runInput
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (turnstileToken) headers['x-turnstile-token'] = turnstileToken
        const res = await fetch(`${API_BASE}/api/simulator`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ac.signal,
        })
        if (res.status === 503) {
          setStatus('unavailable')
          return
        }
        if (res.status === 429) {
          // Daily per-IP / budget cap (§24.70) — surface the backend's honest message.
          const msg = await res
            .json()
            .then((d) => (d as { message?: string }).message)
            .catch(() => null)
          setStatus('error')
          setErrorMessage(msg ?? "You've reached today's run limit — try again tomorrow, or use the contact form.")
          return
        }
        if (!res.ok) {
          setStatus('error')
          setErrorMessage('Could not start the run — please try again.')
          return
        }
        const data = (await res.json()) as { simulation_id?: string }
        if (!data.simulation_id) {
          setStatus('error')
          setErrorMessage('The run did not return an id.')
          return
        }
        id = data.simulation_id
      } catch {
        if (ac.signal.aborted) return
        setStatus('error')
        setErrorMessage('Could not reach the agent.')
        return
      }

      if (ac.signal.aborted) return
      setRunId(id)
      setStatus('running')

      await connectSimulatorStream({
        baseUrl: API_BASE,
        runId: id,
        signal: ac.signal,
        onEvent: (ev) => {
          let payload: unknown
          try {
            payload = JSON.parse(ev.data)
          } catch {
            return // malformed frame — skip
          }
          if (ev.event === 'trace') {
            const tr = payload as SimTraceEvent
            if (tr.t === 'result') {
              if (typeof tr.cost_usd === 'number') setCost(tr.cost_usd)
            } else {
              setTrace((prev) => [...prev, tr])
            }
          } else if (ev.event === 'chat') {
            const text = (payload as { text?: unknown }).text
            if (typeof text === 'string' && text.length > 0) {
              outputRef.current = outputRef.current ? `${outputRef.current}\n\n${text}` : text
              setOutput(outputRef.current)
            }
          } else if (ev.event === 'end') {
            // Host-pushed terminal (STRATEGY §24.21 Δ) — complete or hard-wall.
            const end = payload as {
              reason?: unknown
              cost_usd?: unknown
              has_tailored_resume?: unknown
              cold_email?: unknown
            }
            if (typeof end.cost_usd === 'number' && end.cost_usd > 0) {
              setCost((prev) => prev ?? (end.cost_usd as number))
            }
            if (end.has_tailored_resume === true) setHasTailoredResume(true)
            const ce = end.cold_email
            if (ce && typeof ce === 'object' && typeof (ce as { subject?: unknown }).subject === 'string') {
              const e = ce as { subject: string; body?: unknown }
              setColdEmail({ subject: e.subject, body: typeof e.body === 'string' ? e.body : '' })
            }
            setElapsedMs(Date.now() - startedRef.current)
            if (end.reason !== 'complete' && outputRef.current.length === 0) {
              setStatus('error')
              setErrorMessage('The run timed out before producing a result — please try again.')
            } else {
              setStatus('done')
            }
            ac.abort()
          }
        },
        onError: () => {
          if (ac.signal.aborted) return
          setStatus('error')
          setErrorMessage('The run stream dropped before finishing.')
        },
        onClose: () => {
          // A clean end without a terminal `task` — finish gracefully if we were
          // still running (some output is better than a hang).
          setStatus((s) => (s === 'running' ? 'done' : s))
          setElapsedMs((e) => e ?? Date.now() - startedRef.current)
        },
      })
    })()
  }, [])

  return {
    status,
    runId,
    trace,
    output,
    cost_usd: cost,
    elapsedMs,
    startedAt,
    errorMessage,
    hasTailoredResume,
    coldEmail,
    input,
    start,
    reset,
  }
}
