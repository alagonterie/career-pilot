import * as React from 'react'

export type PollStatus = 'loading' | 'ok' | 'error'

export interface PolledJson<T> {
  data: T | null
  status: PollStatus
  /** Fetch immediately (e.g. right after a mutation) without resetting to the
   *  loading shell — keeps the steady-state poll loop intact. No-op once unmounted. */
  refresh: () => void
}

// §24.137: the portal's live data moves at human pace (recruiter replies land
// over days; the dev generator nudges stages on a similar cadence). The "alive"
// feeling comes from the real-time SSE trace, NOT these JSON polls — so a slow
// poll is plenty and spares the box a needless ~5×/min request on every open
// tab. Callers that genuinely need faster pass `pollMs` explicitly.
const DEFAULT_POLL_MS = 20000

/**
 * Poll a plain-JSON GET endpoint and keep the latest snapshot. The portal's
 * read endpoints (`/api/pipeline`, `/api/architecture`, `/api/system-status`) are
 * plain JSON, not SSE, and the system mutates over time, so a short poll
 * surfaces the change. Client-only: SSR renders the loading shell (`data: null`),
 * the effect fetches + re-polls. A transient blip keeps the last-good data
 * rather than flashing an error — only the cold first failure shows `'error'`.
 *
 * The shared polling primitive behind `usePipeline` (§24.27) and `useArchitecture`
 * (§24.28); a `/live` compact panel (7.3) reuses it too.
 */
export function usePolledJson<T>(url: string, pollMs = DEFAULT_POLL_MS): PolledJson<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [status, setStatus] = React.useState<PollStatus>('loading')
  // Holds the live effect's immediate-refetch; swapped per (re)subscribe, cleared
  // on unmount. Lets `refresh()` poke the current loop without resetting state.
  const refreshRef = React.useRef<() => void>(() => {})

  React.useEffect(() => {
    const ac = new AbortController()
    const hadData = { current: false }
    let timer: ReturnType<typeof setTimeout> | undefined

    // Clean transition on every (re)subscribe — i.e. when `url` changes (the
    // base URL or, via §24.36's seam, the `?__state` override). Resetting to the
    // loading shell here means flipping a surface's state in the dev switcher
    // shows loading → the new state, never a stale flash. The steady-state poll
    // is the timer loop below (same effect instance), so it never resets.
    setStatus('loading')
    setData(null)

    const tick = async (): Promise<void> => {
      // Cancel any pending scheduled tick so an imperative refresh() doesn't
      // leave a second timer running (it re-arms one at the end).
      if (timer) clearTimeout(timer)
      try {
        const res = await fetch(url, { signal: ac.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as T
        setData(json)
        setStatus('ok')
        hadData.current = true
      } catch {
        if (ac.signal.aborted) return
        // Cold failure (no good data yet this subscribe) → the error state. A
        // transient blip AFTER a good read keeps the last-good data (resilience).
        if (!hadData.current) {
          setStatus('error')
          setData(null)
        }
      }
      if (!ac.signal.aborted) timer = setTimeout(() => void tick(), pollMs)
    }

    refreshRef.current = () => {
      if (!ac.signal.aborted) void tick()
    }
    void tick()
    return () => {
      ac.abort()
      if (timer) clearTimeout(timer)
      refreshRef.current = () => {}
    }
  }, [url, pollMs])

  const refresh = React.useCallback(() => refreshRef.current(), [])
  return { data, status, refresh }
}
