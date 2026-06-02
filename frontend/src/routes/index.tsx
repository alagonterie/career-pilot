import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

export const Route = createFileRoute('/')({
  component: Home,
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

type SystemStatus = {
  live_mode: boolean
  pause_state: string
  pause_reason: string | null
  backend: string
}

function Home() {
  const [status, setStatus] = React.useState<SystemStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/api/system-status`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<SystemStatus>
      })
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Career Pilot</h1>
      <p className="mt-2 text-gray-600">Portal frontend — Phase 6.0 bootstrap.</p>

      <section className="mt-6" aria-labelledby="status-heading">
        <h2 id="status-heading" className="text-lg font-semibold">
          Backend status
        </h2>
        {error ? (
          <p role="alert" data-testid="status-error">
            Unavailable: {error}
          </p>
        ) : status ? (
          <dl data-testid="system-status" className="mt-2 grid grid-cols-2 gap-1">
            <dt>Backend</dt>
            <dd data-testid="backend">{status.backend}</dd>
            <dt>Live mode</dt>
            <dd data-testid="live-mode">{String(status.live_mode)}</dd>
            <dt>Pause state</dt>
            <dd data-testid="pause-state">{status.pause_state}</dd>
          </dl>
        ) : (
          <p data-testid="status-loading">Loading…</p>
        )}
      </section>
    </main>
  )
}
