import * as React from 'react'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

/** The `POST /api/sanitize-demo` payload — the real sanitizer run over one
 * synthetic sample (STRATEGY §24.33). */
export interface SanitizeDemo {
  raw: string
  sanitized: string
  redactions: number
  sample: number
  total: number
}

export type SanitizeDemoStatus = 'loading' | 'ok' | 'error'

export interface SanitizeDemoState {
  data: SanitizeDemo | null
  status: SanitizeDemoStatus
  showAnother: () => void
}

/**
 * Drive the `/live` ANONYMIZATION DEMO (PORTAL §5.2): POST `/api/sanitize-demo`
 * for the current synthetic sample, and cycle samples on `showAnother`. The
 * transformation runs server-side (the real sanitizer) — this hook only fetches
 * + renders. Client-only; keeps the last-good result across a re-fetch so the
 * panel never flashes (only a cold first failure shows `error`).
 */
export function useSanitizeDemo(baseUrl: string = API_BASE): SanitizeDemoState {
  const [data, setData] = React.useState<SanitizeDemo | null>(null)
  const [status, setStatus] = React.useState<SanitizeDemoStatus>('loading')
  const [sample, setSample] = React.useState(0)
  const dataRef = React.useRef<SanitizeDemo | null>(null)

  React.useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/sanitize-demo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sample }),
          signal: ac.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as SanitizeDemo
        dataRef.current = json
        setData(json)
        setStatus('ok')
      } catch {
        if (ac.signal.aborted) return
        setStatus(dataRef.current ? 'ok' : 'error') // keep last-good across a re-fetch
      }
    })()
    return () => ac.abort()
  }, [baseUrl, sample])

  const showAnother = React.useCallback(() => {
    setSample((s) => (dataRef.current && dataRef.current.total > 0 ? (s + 1) % dataRef.current.total : s + 1))
  }, [])

  return { data, status, showAnother }
}
