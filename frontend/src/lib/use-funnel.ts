import { useSurfaceState, withState } from './dev-state'
import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * A row of the public funnel read-model as delivered by `GET /api/funnel`
 * (src/modules/portal/api.ts → public_funnel_view + read-time day counts).
 * `application_ref` is the obfuscated label, or the real company name when
 * `public_state === 'public'` (the reveal tier, PORTAL §5.4).
 */
/**
 * Per-kit existence metadata (§24.65) — enums + timestamps only; kit CONTENT
 * never rides the polled funnel payload (the /kit page fetches `/api/kit`).
 */
export interface KitMeta {
  round: string
  interview_type: string
  interview_at: string | null
  status: string
  created_at: string
  has_content: boolean
}

export interface FunnelApplication {
  /** Opaque, unique per-application id — the stable React key + motion layoutId.
   * (`application_ref` is the obfuscated label and is shared across a company's
   * multiple applications, so it must NOT be used as a key.) */
  application_id: string
  application_ref: string
  public_state: string
  role_title: string | null
  status: string
  stage: string
  applied_at: string | null
  stage_entered_at: string | null
  last_activity_at: string | null
  win_confidence: number | null
  /** A one-sentence Gen-AI rationale for the win_confidence score (sanitized). */
  win_confidence_rationale: string | null
  published_learning: string | null
  days_in_stage: number | null
  days_in_pipeline: number | null
  /** Interview kits prepared for this application (§24.65) — all, incl. archived. */
  interview_kits?: KitMeta[]
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
  /** The InfoTip derivation copy (§24.60) — the honest version of `hint`. */
  tip: string
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

  // The `tip` strings are the §24.60 InfoTip derivations — the honest caveats
  // (calendar windows, active-only averaging) live HERE, next to the math they
  // describe, so copy and computation can't drift apart.
  return [
    {
      label: 'Applications YTD',
      value: String(ytd),
      hint: 'applied this year',
      tip: 'Every application with an applied date in the current calendar year. The window resets each January 1.',
    },
    {
      label: 'Interviews this month',
      value: String(interviewsThisMonth),
      hint: 'entered an interview stage',
      tip: 'Applications that entered an interview stage (screening, tech, or final) during the current calendar month — counted by stage entry, not by interview date.',
    },
    {
      label: 'Offers',
      value: String(offers),
      hint: 'received',
      tip: 'Applications currently sitting at the offer stage.',
    },
    {
      label: 'Avg days active',
      value: String(avgDays),
      hint: 'heuristic · active applications',
      tip: 'Mean days-in-pipeline across applications still in flight — closed applications (rejected, withdrawn) are excluded. A heuristic, not a benchmark.',
    },
  ]
}
