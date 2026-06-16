import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'

import { heroStats } from './hero-stats'
import type { FunnelApplication } from './use-funnel'

/**
 * SSR seed for the hero stat line (the `/` polish pass). The stat numbers are
 * normally client-only (live hooks), so on first paint they popped in from a
 * skeleton — a visible "glitch". This server function fetches the same backend
 * the live hooks poll (`/api/funnel`, `/api/telemetry`) through the SSR tunnel +
 * Access service-token (mirrors `getWorkProfile`), and returns the two
 * NON-time-relative segments — "N active applications" + "N agent actions in
 * 24h" — pre-rendered into the SSR HTML. The hooks then take over live.
 *
 * Deliberately excludes "last activity X ago": that segment is relative time
 * computed against `Date.now()`, which differs server↔client and would cause a
 * hydration mismatch (hero-stats.ts keeps it client-only for exactly this
 * reason). It appends after mount — a single short segment at the end of the
 * line, not a skeleton swap.
 *
 * Any failure (unconfigured/unreachable backend, non-200) resolves to an empty
 * seed; the component then falls back to its skeleton until the hooks land.
 */
type SeedEnv = {
  BACKEND_API_BASE?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

interface FunnelJson {
  applications?: FunnelApplication[]
}
interface TelemetryJson {
  local?: { activity_events_24h?: number | null }
}

export const getHeroSeed = createServerFn({ method: 'GET' }).handler(async (): Promise<{ stats: string[] }> => {
  const e = env as SeedEnv
  const base = (e.BACKEND_API_BASE ?? 'http://localhost:3001').replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (e.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = e.CF_ACCESS_CLIENT_ID
  if (e.CF_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = e.CF_ACCESS_CLIENT_SECRET

  try {
    const [funnelRes, telRes] = await Promise.all([
      fetch(`${base}/api/funnel`, { headers, redirect: 'manual' }),
      fetch(`${base}/api/telemetry`, { headers, redirect: 'manual' }),
    ])
    const apps = funnelRes.ok ? (((await funnelRes.json()) as FunnelJson).applications ?? []) : []
    const actionsIn24h = telRes.ok
      ? (((await telRes.json()) as TelemetryJson).local?.activity_events_24h ?? null)
      : null
    // events:[] → only the two count segments; "last activity" stays client-only.
    return { stats: heroStats({ apps, events: [], actionsIn24h }) }
  } catch {
    return { stats: [] }
  }
})
