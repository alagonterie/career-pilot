import * as React from 'react'

import type { PipelineResponse } from './use-pipeline'

/**
 * The site lifecycle (§24.149 L2). `active` is the normal live job search;
 * `concluded` is the accepted-offer retrospective on `/` + `/pipeline`. The value
 * is owner-flipped from `/admin` (`site_lifecycle_state`) and delivered on the
 * pipeline read-model — never auto-inferred (§24.149 D3).
 */
export type SiteLifecycle = 'active' | 'concluded'

/** Normalize the API field — anything but the explicit `'concluded'` is `'active'`
 *  (an older backend omits it; a junk value fails safe to the live search). Pure. */
export function normalizeLifecycle(v: string | null | undefined): SiteLifecycle {
  return v === 'concluded' ? 'concluded' : 'active'
}

/**
 * The dev/E2E-only URL override (`?__lifecycle=concluded`) — mirrors the `?__state`
 * seam so the concluded retrospective is reachable in a functional/visual run
 * without flipping the DB. Gated to dev / the mock-seam build (`VITE_MOCK_SEAM`),
 * so production ignores it entirely and only the server-delivered `site_lifecycle`
 * drives the mode. Client-only (no `window` on SSR → null).
 */
export function lifecycleOverride(): SiteLifecycle | null {
  if (typeof window === 'undefined') return null
  if (!import.meta.env.DEV && import.meta.env.VITE_MOCK_SEAM !== '1') return null
  const v = new URLSearchParams(window.location.search).get('__lifecycle')
  return v === 'concluded' || v === 'active' ? v : null
}

/**
 * Resolve the effective lifecycle for a page. The API value drives SSR + the first
 * client render (so hydration matches); the dev/E2E override is applied only AFTER
 * mount (a `useEffect`), so it never diverges the initial render from the server.
 */
export function useSiteLifecycle(pipeline: PipelineResponse | null): SiteLifecycle {
  const apiValue = normalizeLifecycle(pipeline?.site_lifecycle)
  const [override, setOverride] = React.useState<SiteLifecycle | null>(null)
  React.useEffect(() => {
    setOverride(lifecycleOverride())
  }, [])
  return override ?? apiValue
}
