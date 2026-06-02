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
 * The shared polling primitive behind `useFunnel` (§24.27) and `useArchitecture`
 * (§24.28); a `/live` compact panel (7.3) reuses it too.
 */
export function usePolledJson<T>(url: string, pollMs = DEFAULT_POLL_MS): PolledJson<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [status, setStatus] = React.useState<PollStatus>('loading')

  React.useEffect(() => {
    const ac = new AbortController()
    const hadData = { current: false }
    let timer: ReturnType<typeof setTimeout> | undefined

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
        if (!hadData.current) setStatus('error') // cold failure; keep last-good otherwise
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
