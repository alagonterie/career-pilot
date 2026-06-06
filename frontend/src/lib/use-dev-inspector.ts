import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * Client types + read/write hooks for the dev-only inspector endpoints
 * (`/api/dev/*`, Sub-milestone 24.42b/c). These are served ONLY on the dev stack
 * (`ENVIRONMENT==='dev'`) behind owner-only Cloudflare Access; on any other
 * stack they 404, so the hooks surface a cold `'error'` and the page degrades to
 * an "unavailable" state. Plain JSON (not SSE); the sim mutates over time, so we
 * poll. Writes go through `postKnob`.
 */

export type KnobType = 'boolean' | 'number' | 'cron' | 'enum'
export type KnobGroup = 'sim' | 'pacing' | 'budget' | 'polling' | 'models'

/** One writable knob + its current value and validation metadata (`GET /api/dev/knobs`). */
export interface DevKnob {
  key: string
  value: unknown
  /** The config/defaults.json value — what "reset" falls back to. */
  default: unknown
  /** True when a preferences-tier override exists (so the reset control is meaningful). */
  overridden: boolean
  type: KnobType
  group: KnobGroup
  label: string
  min: number | null
  max: number | null
  integer: boolean
  /** Allowed values for an `enum` knob (drives the select); null otherwise. */
  options: string[] | null
  note: string | null
}

export interface DevKnobsResponse {
  knobs: DevKnob[]
}

/** A simulated application walking the funnel, from the sim's sidecar state. */
export interface DevSimApp {
  appId: string
  company: string
  role: string
  obfuscatedLabel: string
  threadId: string | null
  stageIndex: number
  /** Total linear funnel stages before the terminal email (for an "i/N" read). */
  totalStages: number
  /** The next email this app has queued (classification), or its end state. */
  upcoming: string
  status: 'active' | 'ghosted' | 'closed'
  outcome: 'offer' | 'rejection' | null
  nextFireAtMs: number
}

/** The `applications` row the sim seeded — its live status (the curator advances it). */
export interface DevApplicationRow {
  id: string
  company_name: string | null
  obfuscated_label: string | null
  role_title: string | null
  status: string
  applied_at: string | null
  last_activity_at: string | null
}

export interface DevStateResponse {
  enabled: boolean
  lastSeedAtMs: number
  apps: DevSimApp[]
  applications: DevApplicationRow[]
}

/** The raw candidate_profile row (real PII — served only behind the dev gate). */
export interface DevProfile {
  full_name: string | null
  display_name: string | null
  bio: string | null
  target_roles: string | null
  comp_floor: number | null
  master_resume: string | null
  skills: string | null
  github_url: string | null
  linkedin_url: string | null
  x_url: string | null
  website_url: string | null
  why_this_exists: string | null
  gmail_account: string | null
  updated_at: string
}

export interface OnboardingProgress {
  fields: Array<{ field: string; filled: boolean }>
  filledCount: number
  totalCount: number
  complete: boolean
  nextField: string | null
}

export interface DevPersonaResponse {
  profile: DevProfile | null
  candidateMd: string
  onboarding: OnboardingProgress
}

export type DevStatus = PollStatus

/** Poll the writable knob set. Cold 404 (non-dev stack) → `status: 'error'`. */
export function useDevKnobs(baseUrl: string, pollMs = 4000) {
  return usePolledJson<DevKnobsResponse>(`${baseUrl}/api/dev/knobs`, pollMs)
}

/** Poll the sim's live state + the seeded applications. */
export function useDevState(baseUrl: string, pollMs = 4000) {
  return usePolledJson<DevStateResponse>(`${baseUrl}/api/dev/state`, pollMs)
}

/** Poll the candidate/persona + onboarding progress (changes rarely → slower poll). */
export function useDevPersona(baseUrl: string, pollMs = 10000) {
  return usePolledJson<DevPersonaResponse>(`${baseUrl}/api/dev/persona`, pollMs)
}

export interface KnobWriteResult {
  ok: boolean
  status: number
  /** The server's error string (on a 400) or the echoed write. */
  error?: string
}

/** POST a knob-mutation body to `/api/dev/knobs`, normalizing the result. */
async function postDev(baseUrl: string, body: Record<string, unknown>): Promise<KnobWriteResult> {
  try {
    const res = await fetch(`${baseUrl}/api/dev/knobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      let error: string | undefined
      try {
        const json = (await res.json()) as { error?: string }
        error = json.error
      } catch {
        // non-JSON error body
      }
      return { ok: false, status: res.status, error }
    }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'network error' }
  }
}

/**
 * Write one knob. The server re-validates against the allow-list + ranges (the
 * client validation is only UX); a rejected write returns `{ ok: false }` with
 * the server's reason so the control can revert.
 */
export function postKnob(baseUrl: string, key: string, value: boolean | number | string): Promise<KnobWriteResult> {
  return postDev(baseUrl, { key, value })
}

/** Reset one knob to its default (deletes the preferences override). */
export function resetKnob(baseUrl: string, key: string): Promise<KnobWriteResult> {
  return postDev(baseUrl, { key, reset: true })
}

/** Reset every writable knob to its default at once. */
export function resetAllKnobs(baseUrl: string): Promise<KnobWriteResult> {
  return postDev(baseUrl, { resetAll: true })
}

// ── pure view helpers ─────────────────────────────────────────────────────────

/** A friendlier title for an onboarding field key (e.g. `full_name` → "Full name"). */
export function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    full_name: 'Full name',
    target_roles: 'Target roles',
    comp_floor: 'Comp floor',
    master_resume: 'Master resume',
    bio: 'Bio',
    why_this_exists: 'Why this exists',
  }
  return map[field] ?? field
}

/** Parse a JSON-array text column to a string list (tolerant — `[]` on anything off). */
export function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}
