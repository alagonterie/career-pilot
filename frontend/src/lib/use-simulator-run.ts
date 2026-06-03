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
  errorMessage: string | null
  input: SimRunInput | null
  start: (input: SimRunInput) => void
  reset: () => void
}

/**
 * Drive a recruiter-simulator run (Sub-milestone 8.2, STRATEGY §24.31): POST
 * `/api/simulator`, then open the per-run SSE stream and accumulate the trace
 * (left pane) + output (right pane). A small state machine:
 *   idle → starting (POST) → running (SSE open) → done (terminal `task`)
 *                          ↘ unavailable (503 — disabled / no adapter)
 *                          ↘ error (network / bad response / stream drop)
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
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [input, setInput] = React.useState<SimRunInput | null>(null)

  const acRef = React.useRef<AbortController | null>(null)
  const startedRef = React.useRef(0)

  // Abort any open stream on unmount.
  React.useEffect(() => () => acRef.current?.abort(), [])

  const reset = React.useCallback((): void => {
    acRef.current?.abort()
    acRef.current = null
    setStatus('idle')
    setRunId(null)
    setTrace([])
    setOutput('')
    setCost(null)
    setElapsedMs(null)
    setErrorMessage(null)
    setInput(null)
  }, [])

  const start = React.useCallback((runInput: SimRunInput): void => {
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    setStatus('starting')
    setRunId(null)
    setTrace([])
    setOutput('')
    setCost(null)
    setElapsedMs(null)
    setErrorMessage(null)
    setInput(runInput)
    startedRef.current = Date.now()

    void (async () => {
      let id: string
      try {
        const res = await fetch(`${API_BASE}/api/simulator`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runInput),
          signal: ac.signal,
        })
        if (res.status === 503) {
          setStatus('unavailable')
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
          setErrorMessage('The simulator did not return a run id.')
          return
        }
        id = data.simulation_id
      } catch {
        if (ac.signal.aborted) return
        setStatus('error')
        setErrorMessage('Could not reach the simulator.')
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
          } else if (ev.event === 'chat' || ev.event === 'task') {
            const text = (payload as { text?: unknown }).text
            if (typeof text === 'string' && text.length > 0) {
              setOutput((prev) => (prev ? `${prev}\n\n${text}` : text))
            }
            if (ev.event === 'task') {
              // Terminal message — the run is complete. Close the live stream.
              setElapsedMs(Date.now() - startedRef.current)
              setStatus('done')
              ac.abort()
            }
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

  return { status, runId, trace, output, cost_usd: cost, elapsedMs, errorMessage, input, start, reset }
}
