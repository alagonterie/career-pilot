import { useSurfaceState, withState } from './dev-state'
import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * A row of the public pipeline read-model as delivered by `GET /api/funnel`
 * (src/modules/portal/api.ts → public_funnel_view + read-time day counts).
 * Naming boundary (§24.77 D3): the visitor-facing concept is the "pipeline"; the
 * internal fetch URL + read-model keep their `funnel` names (unrenamed plumbing).
 * `application_ref` is the obfuscated label, or the real company name when
 * `public_state === 'public'` (the reveal tier, PORTAL §5.4).
 */
/**
 * Per-kit existence metadata (§24.65) — enums + timestamps only; kit CONTENT
 * never rides the polled pipeline payload (the /kit page fetches `/api/kit`).
 */
export interface KitMeta {
  round: string
  interview_type: string
  interview_at: string | null
  status: string
  created_at: string
  has_content: boolean
}

/**
 * A published reflection projected for the /pipeline drawer's "Lessons learned"
 * list (§24.117). `excerpt` is already sanitized + truncated host-side; `kind`
 * is the free-form reflection category (null for a legacy single-excerpt row
 * synthesized from `published_learning`); `created_at` may be null likewise.
 */
export interface LearningMeta {
  kind: string | null
  created_at: string | null
  excerpt: string
}

export interface PipelineApplication {
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
  /** Published reflections for this application (§24.117) — all, newest first. */
  learnings?: LearningMeta[]
}

const LEARNING_KIND_LABELS: Record<string, string> = {
  offer: 'After the offer',
  rejection: 'After the rejection',
  rejected: 'After the rejection',
  final: 'After the final round',
  interview: 'After the interview',
  screening: 'After the screen',
  outreach: 'On outreach',
  withdrawn: 'After withdrawing',
}

/**
 * Humanize a learning's free-form `kind` into a short retro label (§24.117), or
 * null when absent (a legacy excerpt synthesized from `published_learning` has
 * no kind). An unrecognized kind passes through as-authored — never mangled.
 */
export function learningKindLabel(kind: string | null): string | null {
  if (!kind) return null
  const k = kind.trim().toLowerCase()
  if (!k) return null
  return LEARNING_KIND_LABELS[k] ?? kind.trim()
}

export interface PipelineResponse {
  applications: PipelineApplication[]
  stage_counts: Record<string, number>
}

export type PipelineStatus = PollStatus

export interface PipelineState {
  data: PipelineResponse | null
  status: PipelineStatus
}

/**
 * Poll `GET /api/funnel` and keep the latest snapshot. `/api/funnel` is plain
 * JSON (not SSE), and the system mutates stages over time (recruiter replies,
 * the dev `maybeAdvanceFunnel` generator), so a short poll surfaces the motion
 * — the board's `motion/react` layout animation does the rest. Delegates to the
 * shared `usePolledJson` primitive (client-only; keeps last-good data on a
 * transient blip; only a cold first failure shows `'error'`).
 */
export function usePipeline(baseUrl: string, pollMs?: number): PipelineState {
  const forced = useSurfaceState('pipeline')
  return usePolledJson<PipelineResponse>(withState(`${baseUrl}/api/funnel`, forced), pollMs)
}

export interface StatTile {
  label: string
  value: string
  hint: string
  /** The InfoTip derivation copy (§24.60) — the honest version of `hint`, or
   * `null` for tiles whose label already says it (§24.79 D1: only the heuristic
   * `Avg days active` tile earns a tip; the rest are self-evident). */
  tip: string | null
}

const INTERVIEW_STAGES = new Set(['screening', 'tech', 'final'])
const CLOSED_STAGES = new Set(['rejected', 'withdrawn'])

/**
 * The four PORTAL §5.4 stat tiles, derived purely from the pipeline rows (no new
 * endpoint). Date-windowed counts are honest heuristics over the placeholder
 * data; `Avg days active` is labeled low-rigor. Pure + testable.
 */
export function deriveStatTiles(apps: PipelineApplication[]): StatTile[] {
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

  // The first three tiles are clear from their labels (§24.79 D1) → `tip: null`,
  // no InfoTip. Only `Avg days active` keeps one: its §24.60 derivation (the
  // active-only averaging caveat) isn't derivable from the name, so the honest
  // copy lives HERE, next to the math it describes, so the two can't drift apart.
  return [
    {
      label: 'Applications YTD',
      value: String(ytd),
      hint: 'applied this year',
      tip: null,
    },
    {
      label: 'Interviews this month',
      value: String(interviewsThisMonth),
      hint: 'entered an interview stage',
      tip: null,
    },
    {
      label: 'Offers',
      value: String(offers),
      hint: 'received',
      tip: null,
    },
    {
      label: 'Avg days active',
      value: String(avgDays),
      hint: 'heuristic · active applications',
      tip: 'Mean days-in-pipeline across applications still in flight — closed applications (rejected, withdrawn) are excluded. A heuristic, not a benchmark.',
    },
  ]
}
