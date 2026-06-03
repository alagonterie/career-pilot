import { useSurfaceState, withState } from './dev-state'
import { usePolledJson, type PollStatus } from './use-polled-json'

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

export type FunnelStatus = PollStatus

export interface FunnelState {
  data: FunnelResponse | null
  status: FunnelStatus
}

/**
 * Poll `GET /api/funnel` and keep the latest snapshot. `/api/funnel` is plain
 * JSON (not SSE), and the system mutates stages over time (recruiter replies,
 * the dev `maybeAdvanceFunnel` generator), so a short poll surfaces the motion
 * — the board's `motion/react` layout animation does the rest. Delegates to the
 * shared `usePolledJson` primitive (client-only; keeps last-good data on a
 * transient blip; only a cold first failure shows `'error'`).
 */
export function useFunnel(baseUrl: string, pollMs?: number): FunnelState {
  const forced = useSurfaceState('funnel')
  return usePolledJson<FunnelResponse>(withState(`${baseUrl}/api/funnel`, forced), pollMs)
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
