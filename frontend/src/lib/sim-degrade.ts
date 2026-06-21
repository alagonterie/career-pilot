/**
 * Simulator "degradation as a feature" (§24.150). The backend computes a granular
 * start reason but collapses it at the HTTP boundary (budget + per-IP → 429,
 * disabled + backend-not-ready → 503); it re-surfaces the raw reason in the non-ok
 * `/api/simulator` body so the frontend can BRAND each unavailable state — pointing
 * the dead-ended visitor at the surface that explains the cap they just hit (the
 * thing that blocked them becomes the proof the showcase is real).
 */
export type SimDegradeReason = 'budget' | 'rate_limit' | 'disabled'

/**
 * Map the backend's granular start reason (the `/api/simulator` non-ok body
 * `reason`) to the frontend's branded fallback variant. A real fault
 * (`backend_not_ready`) or an unknown/absent reason → `null` (the honest generic
 * fallback — no "feature" spin on an actual crash). Pure.
 */
export function degradeReasonFromApi(reason: string | null | undefined): SimDegradeReason | null {
  switch (reason) {
    case 'budget_exceeded':
      return 'budget'
    case 'rate_limited_ip':
      return 'rate_limit'
    case 'simulator_disabled':
      return 'disabled'
    default:
      return null
  }
}

export interface SimSeamOverride {
  status: 'unavailable' | 'error'
  degradeReason: SimDegradeReason | null
}

/**
 * The dev/E2E-only `?__sim=` override on `/watch` (§24.150 D4) — reaches each
 * branded fallback without exhausting the real budget (for visual coverage + the
 * owner's screenshot). Gated to dev / the mock-seam build (`VITE_MOCK_SEAM`), so
 * production ignores it entirely. Client-only (no `window` on SSR → null).
 */
export function simSeamOverride(): SimSeamOverride | null {
  if (typeof window === 'undefined') return null
  if (!import.meta.env.DEV && import.meta.env.VITE_MOCK_SEAM !== '1') return null
  const v = new URLSearchParams(window.location.search).get('__sim')
  switch (v) {
    case 'budget':
      return { status: 'unavailable', degradeReason: 'budget' }
    case 'rate_limit':
      return { status: 'unavailable', degradeReason: 'rate_limit' }
    case 'disabled':
      return { status: 'unavailable', degradeReason: 'disabled' }
    case 'unavailable':
      return { status: 'unavailable', degradeReason: null }
    case 'error':
      return { status: 'error', degradeReason: null }
    default:
      return null
  }
}
