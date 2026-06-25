import { useEffect } from 'react'

/**
 * The first-party visit beacon (STRATEGY §24.177 D2). When the landing page loads
 * with a transparent `?from=<slug>` source, fire a single `POST /api/visit` after
 * hydration so the backend can attribute the visit — IF the slug is a known owner
 * source (the server allow-lists; an unknown one is silently ignored).
 *
 * Client-only by construction (an effect never runs during SSR, so the `?from=`
 * stays out of the server render and there's no hydration double-count). The
 * fire-once guards (a session key per slug) are politeness only — the LOAD-BEARING
 * anti-spam is the server's windowed (slug, ip_hash) write-dedup, since a client
 * guard is bypassable. Wholly best-effort: any failure is swallowed.
 */

const SLUG_RE = /^[a-z0-9_]{1,40}$/

export function useVisitBeacon(apiBase: string): void {
  useEffect(() => {
    if (typeof window === 'undefined') return

    let slug: string | null = null
    try {
      slug = new URLSearchParams(window.location.search).get('from')
    } catch {
      return
    }
    if (!slug || !SLUG_RE.test(slug)) return

    // Fire once per source per session (a re-render or client nav back to `/`
    // must not re-beacon). sessionStorage may be blocked (private mode) — fall
    // through to the network either way; the server dedup still bounds repeats.
    const key = `cp_visit_beacon:${slug}`
    try {
      if (window.sessionStorage.getItem(key)) return
      window.sessionStorage.setItem(key, '1')
    } catch {
      /* sessionStorage unavailable — rely on the server-side dedup */
    }

    void fetch(`${apiBase}/api/visit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: slug }),
      keepalive: true,
    }).catch(() => {
      /* a beacon must never surface a failure to the page */
    })
  }, [apiBase])
}
