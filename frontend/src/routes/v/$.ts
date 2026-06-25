import { createFileRoute } from '@tanstack/react-router'

/**
 * Short-alias redirect — `/v/<slug>` → `/?from=<slug>` (STRATEGY §24.177 D1).
 *
 * A tidy alternative to the canonical, transparent `?from=<slug>` link for the
 * one place characters are tight (a printed/short link). A PURE edge 302 — it
 * does NOT record anything; the landing-page beacon on `/` is the sole recorder
 * (so the alias and the canonical link both attribute through exactly one path).
 * Validated to the slug grammar (`^[a-z0-9_]{1,40}$`) so a crafted value can't be
 * smuggled into the `Location` header; anything else just lands on `/`.
 */

const SLUG_RE = /^[a-z0-9_]{1,40}$/

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}

function aliasRedirect(request: Request): Response {
  const slug = new URL(request.url).pathname.slice('/v/'.length)
  return redirect(SLUG_RE.test(slug) ? `/?from=${slug}` : '/')
}

export const Route = createFileRoute('/v/$')({
  server: {
    handlers: {
      GET: ({ request }) => aliasRedirect(request),
    },
  },
})
