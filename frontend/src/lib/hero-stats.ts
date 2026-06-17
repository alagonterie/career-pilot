import type { AuditEvent } from './use-activity-stream'
import type { FunnelApplication } from './use-funnel'

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

// In-flight = not closed. Mirrors `use-funnel.ts`'s CLOSED_STAGES; kept local so
// the two modules don't couple over a private constant.
const CLOSED_STAGES = new Set(['rejected', 'withdrawn'])

/** Active = applications still in flight (offers included; only closed excluded). */
export function activeApplicationCount(apps: FunnelApplication[]): number {
  return apps.filter((a) => !CLOSED_STAGES.has(a.stage)).length
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
  apps: FunnelApplication[]
  events: AuditEvent[]
  /** `telemetry.local.activity_events_24h`, or null while the poll is in flight. */
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
