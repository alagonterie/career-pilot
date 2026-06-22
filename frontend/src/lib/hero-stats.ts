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
 * "searching since {Mon YYYY}" — the earliest application's month, the honest
 * anchor for when the search began (§24.149, owner-requested). Absent until the
 * first application exists (at cold-start the "warming up" line owns that moment).
 * An ABSOLUTE date (no `now`), formatted in UTC so the SSR seed and the client
 * hydrate the IDENTICAL string (the relative `last activity` is the only
 * `now`-derived segment). Pure + testable; null when no application carries an
 * `applied_at`.
 */
export function searchingSince(apps: PipelineApplication[]): string | null {
  let earliest = Infinity
  for (const a of apps) {
    if (!a.applied_at) continue
    const t = new Date(a.applied_at).getTime()
    if (Number.isFinite(t) && t < earliest) earliest = t
  }
  if (!Number.isFinite(earliest)) return null
  return new Date(earliest).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Build the hero stat segments. Returns `[]` (renders nothing — the reserved
 * line collapses to its min-height) until real data lands. Pure + testable.
 */
export function heroStats({ apps, events, actionsIn24h, now = Date.now() }: HeroStatInputs): string[] {
  const out: string[] = []

  const active = activeApplicationCount(apps)
  // §24.156: "active applications" (not "active job applications") — drops the
  // redundant "job" so the headline fits two clean lines down to the narrowest
  // phones (the hook one line up already frames it as the job search). Still
  // fully clear, never cryptic.
  if (active > 0) out.push(`${active} active application${active === 1 ? '' : 's'}`)

  // The "since when" anchor sits right after the count — "5 applications, since Mar".
  const since = searchingSince(apps)
  if (since) out.push(`searching since ${since}`)

  if (actionsIn24h != null && actionsIn24h > 0) {
    out.push(`${actionsIn24h} agent action${actionsIn24h === 1 ? '' : 's'} in 24h`)
  }

  const last = events[events.length - 1]
  if (last) out.push(`last activity ${relativeAgo(last.ts, now)}`)

  return out
}

/**
 * §24.156: split the flat hero segments into the two DELIBERATE display lines —
 * a headline (the search identity: active count + "searching since") and a dimmer
 * freshness line (the live signals: agent actions + last activity). Four
 * `·`-separated segments never fit the `max-w-xl` hero on one row, so they used to
 * wrap into a lop-sided bullet stack with an orphaned leading `·`; a designed
 * two-line split keeps every `·` *inside* a line, where it can't orphan. The flat
 * `counts` arrive in heroStats order (`[active?, since?, actions?]`); the agent-
 * actions count is the only one that belongs to the freshness line, and
 * `lastActivity` always does. Pure + testable so the SSR seed stays a flat array.
 */
export function heroStatLines(
  counts: string[],
  lastActivity: string | null,
): { headline: string[]; freshness: string[] } {
  const headline: string[] = []
  const freshness: string[] = []
  for (const c of counts) {
    if (/agent action/.test(c)) freshness.push(c)
    else headline.push(c)
  }
  if (lastActivity) freshness.push(lastActivity)
  return { headline, freshness }
}

/**
 * Which treatment the hero stat line renders (§24.149 L1). The skeleton is for a
 * genuine first-load ONLY; once the polls settle with no activity to show — a
 * cold launch, or a freshly-reset pipeline — we render an honest "warming up"
 * freshness line, never a perpetual skeleton (the cold-start "looks broken" bug).
 * A hard backend outage collapses the line entirely (the availability badge above
 * already carries the offline signal). Pure + testable, so the decision isn't
 * trapped in JSX the SSR-seed path can't reach in an `?__state=empty` E2E.
 */
export type HeroStatPhase = 'stats' | 'loading' | 'fresh' | 'offline'
export function heroStatPhase(opts: { hasStats: boolean; ready: boolean; offline: boolean }): HeroStatPhase {
  if (opts.hasStats) return 'stats'
  if (!opts.ready) return 'loading'
  if (opts.offline) return 'offline'
  return 'fresh'
}
