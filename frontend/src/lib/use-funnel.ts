import * as React from 'react'

/**
 * A row of the public funnel read-model as delivered by `GET /api/funnel`
 * (src/modules/portal/api.ts → public_funnel_view + read-time day counts).
 * `application_ref` is the obfuscated label, or the real company name when
 * `public_state === 'public'` (the reveal tier, PORTAL §5.4).
 */
export interface FunnelApplication {
  application_ref: string
  public_state: string
  role_title: string | null
  status: string
  stage: string
  applied_at: string | null
  stage_entered_at: string | null
  last_activity_at: string | null
  win_confidence: number | null
  published_learning: string | null
  days_in_stage: number | null
  days_in_pipeline: number | null
}

export interface FunnelResponse {
  applications: FunnelApplication[]
  stage_counts: Record<string, number>
}

export type FunnelStatus = 'loading' | 'ok' | 'error'

export interface FunnelState {
  data: FunnelResponse | null
  status: FunnelStatus
}

const DEFAULT_POLL_MS = 4000

/**
 * Poll `GET /api/funnel` and keep the latest snapshot. `/api/funnel` is plain
 * JSON (not SSE), and the system mutates stages over time (recruiter replies,
 * the dev `maybeAdvanceFunnel` generator), so a short poll surfaces the motion
 * — the board's `motion/react` layout animation does the rest. Client-only:
 * SSR renders the loading shell, the effect fetches + re-polls (mirrors
 * use-activity-stream.ts). A transient fetch blip keeps the last-good data
 * rather than flashing an error (only the cold first failure shows 'error').
 */
export function useFunnel(baseUrl: string, pollMs = DEFAULT_POLL_MS): FunnelState {
  const [data, setData] = React.useState<FunnelResponse | null>(null)
  const [status, setStatus] = React.useState<FunnelStatus>('loading')

  React.useEffect(() => {
    const ac = new AbortController()
    const hadData = { current: false }
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`${baseUrl}/api/funnel`, { signal: ac.signal })
        if (!res.ok) throw new Error(`funnel HTTP ${res.status}`)
        const json = (await res.json()) as FunnelResponse
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
  }, [baseUrl, pollMs])

  return { data, status }
}

export interface StatTile {
  label: string
  value: string
  hint: string
}

const INTERVIEW_STAGES = new Set(['screening', 'tech', 'final'])
const CLOSED_STAGES = new Set(['rejected', 'withdrawn'])

/**
 * The four PORTAL §5.4 stat tiles, derived purely from the funnel rows (no new
 * endpoint). Date-windowed counts are honest heuristics over the placeholder
 * data; `Avg days in funnel` is labeled low-rigor. Pure + testable.
 */
export function deriveStatTiles(apps: FunnelApplication[]): StatTile[] {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()

  const ytd = apps.filter((a) => a.applied_at != null && new Date(a.applied_at).getUTCFullYear() === year).length

  const interviewsThisMonth = apps.filter((a) => {
    if (!INTERVIEW_STAGES.has(a.stage) || !a.stage_entered_at) return false
    const t = new Date(a.stage_entered_at)
    return t.getUTCFullYear() === year && t.getUTCMonth() === month
  }).length

  const offers = apps.filter((a) => a.stage === 'offer').length

  const inflight = apps.filter((a) => !CLOSED_STAGES.has(a.stage) && a.days_in_pipeline != null)
  const avgDays = inflight.length
    ? Math.round(inflight.reduce((sum, a) => sum + (a.days_in_pipeline ?? 0), 0) / inflight.length)
    : 0

  return [
    { label: 'Applications YTD', value: String(ytd), hint: 'applied this year' },
    { label: 'Interviews this month', value: String(interviewsThisMonth), hint: 'entered an interview stage' },
    { label: 'Offers', value: String(offers), hint: 'received' },
    { label: 'Avg days in funnel', value: String(avgDays), hint: 'heuristic · active applications' },
  ]
}
