import { PIPELINE_STAGE_SET } from './pipeline-stages'
import type { AuditEvent } from './use-activity-stream'
import type { PipelineApplication } from './use-pipeline'

/**
 * The honest live stat line under the hero CTAs (PORTAL §5.1 Viewport 1) — the
 * first-paint proof that `/` is a live system, not a screenshot. Three real
 * numbers, each sourced from a hook already on the home and each OMITTED when
 * its underlying value is empty/unknown (the honesty rule — a missing number is
 * absent, never faked or zero-padded). The spec's original third stat
 * ("cache hit rate") is deliberately dropped: it's LLM prompt-cache jargon that
 * reads as cryptic to a recruiter (§24.71 hero audit). `activity_events_24h`
 * ("agent actions in 24h") replaces it — same "actively working right now"
 * signal, in plain language.
 */

/**
 * Active = an application in one of the five board stages (applied/screening/
 * tech/final/offer). Counting on the canonical `PIPELINE_STAGE_SET` (the same
 * source the strip below renders) — NOT a negative "exclude closed" list — is
 * deliberate (§24.97-A): it drops both the closed `rejected`/`withdrawn` AND the
 * pre-application `bookmarked` lead (a role the agent found but hasn't applied to,
 * surfaced off-board), so the headline equals the strip's column sum by
 * construction and never reads "3 active" over a strip summing to 2.
 */
export function activeApplicationCount(apps: PipelineApplication[]): number {
  return apps.filter((a) => PIPELINE_STAGE_SET.has(a.stage)).length
}

/**
 * Coarse, honest relative time ("just now" / "Xm" / "Xh" / "Xd ago"). Computed
 * client-side only (the activity stream is empty on SSR), so the differing
 * server/client `now` never causes a hydration mismatch.
 */
export function relativeAgo(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export interface HeroStatInputs {
  apps: PipelineApplication[]
  events: AuditEvent[]
  /** `telemetry.local.agent_actions_24h` (the NON-turn 24h count, §24.97-B), or
   *  null while the poll is in flight. Must exclude turns so "agent actions in 24h"
   *  never contradicts the turn-excluding "last activity" on the same line. */
  actionsIn24h: number | null
  now?: number
}

/**
 * Build the hero stat segments. Returns `[]` (renders nothing — the reserved
 * line collapses to its min-height) until real data lands. Pure + testable.
 */
export function heroStats({ apps, events, actionsIn24h, now = Date.now() }: HeroStatInputs): string[] {
  const out: string[] = []

  const active = activeApplicationCount(apps)
  if (active > 0) out.push(`${active} active job application${active === 1 ? '' : 's'}`)

  if (actionsIn24h != null && actionsIn24h > 0) {
    out.push(`${actionsIn24h} agent action${actionsIn24h === 1 ? '' : 's'} in 24h`)
  }

  const last = events[events.length - 1]
  if (last) out.push(`last activity ${relativeAgo(last.ts, now)}`)

  return out
}
