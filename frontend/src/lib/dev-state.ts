import * as React from 'react'

/**
 * Dev-state seam (§24.36 / Sub-milestone 36.1) — the client half of the
 * mock-only async-state override. Each async surface reads its effective state
 * here and, when it's not `normal`, appends `?__state=<state>` to its API
 * fetches. The portal API honors `__state` ONLY under the mock seam
 * (PORTAL_MOCK_STATE_SEAM — dev/E2E); production ignores it, so forwarding is
 * always safe to leave on (the server is the perimeter).
 *
 * Two writers feed one store: the page URL's `?__state=` (an E2E/snapshot
 * convenience — sets the default for every surface) and the dev state-switcher
 * panel (per-surface, in-memory, dev-only). The switcher overlay itself is
 * tree-shaken from the production bundle (`import.meta.env.DEV`).
 */
export type SurfaceState = 'normal' | 'loading' | 'empty' | 'error'
export type Surface = 'funnel' | 'activity' | 'architecture' | 'telemetry'

export const SURFACES: { id: Surface; label: string }[] = [
  { id: 'funnel', label: 'Funnel' },
  { id: 'activity', label: 'Activity' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'telemetry', label: 'Telemetry' },
]

export const SURFACE_STATES: SurfaceState[] = ['normal', 'loading', 'empty', 'error']

function isSurfaceState(v: string | null): v is SurfaceState {
  return v === 'normal' || v === 'loading' || v === 'empty' || v === 'error'
}

/** The URL-derived default (E2E/snapshots drive it via `?__state=`). Read once at
 * module load on the client; SSR has no `window`, so it defaults to `normal`. */
function urlGlobal(): SurfaceState {
  if (typeof window === 'undefined') return 'normal'
  const v = new URLSearchParams(window.location.search).get('__state')
  return isSurfaceState(v) ? v : 'normal'
}

let globalDefault: SurfaceState = urlGlobal()
const overrides = new Map<Surface, SurfaceState>()
const listeners = new Set<() => void>()

/** The state a surface should render: its explicit override, else the URL global. */
export function effectiveState(surface: Surface): SurfaceState {
  return overrides.get(surface) ?? globalDefault
}

/** A stable, comparable snapshot of all surfaces (drives useSyncExternalStore). */
let snapshot = computeSnapshot()
function computeSnapshot(): string {
  return SURFACES.map((s) => effectiveState(s.id)).join('|')
}
function emit(): void {
  snapshot = computeSnapshot()
  for (const l of listeners) l()
}

export function setSurfaceState(surface: Surface, state: SurfaceState): void {
  if (state === 'normal') overrides.delete(surface)
  else overrides.set(surface, state)
  emit()
}

export function resetSurfaceStates(): void {
  overrides.clear()
  globalDefault = 'normal'
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Subscribe to one surface's effective state (re-renders the caller on change). */
export function useSurfaceState(surface: Surface): SurfaceState {
  return React.useSyncExternalStore(
    subscribe,
    () => effectiveState(surface),
    () => 'normal' as SurfaceState,
  )
}

/** Subscribe to all surfaces at once (the switcher panel). */
export function useAllSurfaceStates(): Record<Surface, SurfaceState> {
  React.useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => '',
  )
  return Object.fromEntries(SURFACES.map((s) => [s.id, effectiveState(s.id)])) as Record<Surface, SurfaceState>
}

/** Append the mock `__state` param when a surface is overridden. A no-op for
 * `normal`. The server honors it only under the mock seam; prod ignores it. */
export function withState(url: string, state: SurfaceState): string {
  if (state === 'normal') return url
  return `${url}${url.includes('?') ? '&' : '?'}__state=${state}`
}
