/**
 * Standby — the edge-resident state for the deliberate hibernation (§24.189).
 *
 * When the owner puts the search on standby the GCP VM is STOPPED: there is no
 * host, no DB, no tunnel. So the flag that says "we're on standby" cannot live in
 * `system_modes` like every other mode — that table is on the disk we just powered
 * down. It lives in Workers KV instead, the one store that survives the teardown,
 * and the Worker reads it to decide what the public site renders.
 *
 * Two keys:
 *   `state`   — the mode itself (+ when, an optional owner note, the last known VM state)
 *   `profile` — a snapshot of `/api/profile` taken at ENTRY, while the box is still
 *               up. Without it the standby page would fall back to the committed
 *               `Jane Doe` / `example.com` placeholders, so the one page a visitor
 *               can still reach would be the one page that lies about who owns it.
 *
 * Pure helpers (parsing/defaults) live here and are unit-tested; the KV reads/writes
 * are server-only and take the namespace as an argument so they're testable with a
 * fake.
 */

export type StandbyMode = 'active' | 'standby'

/** Last known VM state. Advisory only — it's whatever the workflow last reported,
 *  not a live probe (there's nothing to probe from the edge). */
export type StandbyVmState = 'running' | 'stopping' | 'stopped' | 'starting' | 'unknown'

export interface StandbyState {
  mode: StandbyMode
  /** ISO timestamp of the last transition, or null if never set. */
  since: string | null
  /** Optional owner line rendered on the public standby page. */
  note: string | null
  vm: StandbyVmState
  /** ISO timestamp of the last write to this record. */
  updatedAt: string | null
}

/** The identity the standby page needs to stay honest with the origin gone. */
export interface StandbySnapshot {
  name: string | null
  email: string | null
  github: string | null
  linkedin: string | null
  x: string | null
  website: string | null
  capturedAt: string | null
}

export const STANDBY_STATE_KEY = 'state'
export const STANDBY_PROFILE_KEY = 'profile'

/** The safe default: a missing/unreadable record means the site is LIVE. Failing
 *  open is deliberate — a KV hiccup must never black out a working public site. */
export const ACTIVE_STATE: StandbyState = {
  mode: 'active',
  since: null,
  note: null,
  vm: 'running',
  updatedAt: null,
}

const VM_STATES = new Set<StandbyVmState>(['running', 'stopping', 'stopped', 'starting', 'unknown'])

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/**
 * Parse a stored state record defensively. Anything we can't read as an explicit
 * `standby` resolves to ACTIVE — see the fail-open note above. Pure + tested.
 */
export function parseStandbyState(raw: string | null | undefined): StandbyState {
  if (!raw) return ACTIVE_STATE
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return ACTIVE_STATE
  }
  if (typeof obj !== 'object' || obj === null) return ACTIVE_STATE
  const r = obj as Record<string, unknown>
  if (r.mode !== 'standby') return ACTIVE_STATE
  const vm = r.vm as StandbyVmState
  return {
    mode: 'standby',
    since: str(r.since),
    note: str(r.note),
    vm: VM_STATES.has(vm) ? vm : 'unknown',
    updatedAt: str(r.updatedAt),
  }
}

/** Parse the entry snapshot. Every field is independently optional — a partial
 *  profile still renders (the page omits the links it doesn't have). Pure. */
export function parseStandbySnapshot(raw: string | null | undefined): StandbySnapshot | null {
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  // Arrays pass a bare `typeof === 'object'`, so exclude them explicitly.
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const r = obj as Record<string, unknown>
  return {
    name: str(r.name),
    email: str(r.email),
    github: str(r.github),
    linkedin: str(r.linkedin),
    x: str(r.x),
    website: str(r.website),
    capturedAt: str(r.capturedAt),
  }
}

/**
 * Whether a given path still renders normally while on standby (§24.189 D6).
 *
 * Standby serves ONE page everywhere rather than a half-live site: `/work`, the
 * footer socials and `/contact` are all SSR'd from the backend, so with the origin
 * gone they'd degrade to the committed placeholders and a form that posts into the
 * void. The exceptions are the edge console (the whole point — it must work with
 * the VM stopped) and the static legal pages (no backend, and they should stay
 * reachable for anything already linking them).
 */
const STANDBY_EXEMPT_PATHS = new Set(['/admin/standby', '/privacy', '/terms'])

export function isStandbyExempt(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/'
  return STANDBY_EXEMPT_PATHS.has(p)
}

/** A coarse "N days" for the standby page's optional since-line. Pure. */
export function standbyDuration(since: string | null, now: number = Date.now()): string | null {
  if (!since) return null
  const t = Date.parse(since)
  if (!Number.isFinite(t)) return null
  const days = Math.floor((now - t) / 86_400_000)
  if (days < 1) return null
  return days === 1 ? '1 day' : `${days} days`
}
