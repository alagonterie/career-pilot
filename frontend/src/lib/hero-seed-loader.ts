import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'

import { heroStats, relativeAgo } from './hero-stats'
import type { PipelineApplication } from './use-pipeline'

/**
 * SSR seed for the hero stat line (the `/` polish pass). The stat numbers are
 * normally client-only (live hooks), so on first paint they popped in from a
 * skeleton. This server function fetches the same backend the live hooks poll
 * (`/api/pipeline`, `/api/telemetry`) through the SSR tunnel + Access service-token
 * (mirrors `getWorkProfile`) and returns the full line, pre-rendered:
 *
 *   - `counts`       — "N active applications" + "N agent actions in 24h"
 *   - `lastActivity` — "last activity X ago", computed server-side from
 *     `telemetry.local.last_activity_at` (the latest NON-turn audit ts — the same
 *     event the home ticker's stream reports).
 *
 * The component renders this seed verbatim until the live hooks settle, so the
 * whole line is in the SSR HTML and hydrates with the identical string (no
 * relative-time mismatch — the client uses the seed STRING, it doesn't recompute
 * until after mount, when the live stream supplies the same event). Because the
 * seed and the stream point at the same latest event, the live takeover doesn't
 * shift the line.
 *
 * Any failure (unconfigured/unreachable backend, non-200) resolves to an empty
 * seed; the component then falls back to its skeleton until the hooks land.
 */
type SeedEnv = {
  BACKEND_API_BASE?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

interface PipelineJson {
  applications?: PipelineApplication[]
}
interface TelemetryJson {
  local?: { agent_actions_24h?: number | null; last_activity_at?: string | null }
}

export interface HeroSeed {
  counts: string[]
  lastActivity: string | null
}

export const getHeroSeed = createServerFn({ method: 'GET' }).handler(async (): Promise<HeroSeed> => {
  const e = env as SeedEnv
  const base = (e.BACKEND_API_BASE ?? 'http://localhost:3001').replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (e.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = e.CF_ACCESS_CLIENT_ID
  if (e.CF_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = e.CF_ACCESS_CLIENT_SECRET

  try {
    const [pipelineRes, telRes] = await Promise.all([
      fetch(`${base}/api/pipeline`, { headers, redirect: 'manual' }),
      fetch(`${base}/api/telemetry`, { headers, redirect: 'manual' }),
    ])
    const apps = pipelineRes.ok ? (((await pipelineRes.json()) as PipelineJson).applications ?? []) : []
    const tel = telRes.ok ? ((await telRes.json()) as TelemetryJson).local : undefined
    // events:[] → heroStats returns only the two count segments; the last-activity
    // string is computed here from the telemetry ts (it stays out of heroStats so
    // the client can keep the seed string until the live stream supplies one).
    const counts = heroStats({ apps, events: [], actionsIn24h: tel?.agent_actions_24h ?? null })
    const lastAt = tel?.last_activity_at ?? null
    return { counts, lastActivity: lastAt ? `last activity ${relativeAgo(lastAt)}` : null }
  } catch {
    return { counts: [], lastActivity: null }
  }
})
