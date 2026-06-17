import * as React from 'react'

export type PollStatus = 'loading' | 'ok' | 'error'

export interface PolledJson<T> {
  data: T | null
  status: PollStatus
}

const DEFAULT_POLL_MS = 4000

/**
 * Poll a plain-JSON GET endpoint and keep the latest snapshot. The portal's
 * read endpoints (`/api/funnel`, `/api/architecture`, `/api/system-status`) are
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

    void tick()
    return () => {
      ac.abort()
      if (timer) clearTimeout(timer)
    }
  }, [url, pollMs])

  return { data, status }
}
