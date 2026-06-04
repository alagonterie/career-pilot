import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

/**
 * BFF proxy — `/api/*` (STRATEGY §24.39 D12).
 *
 * The browser talks ONLY to this Worker origin (`hire.<domain>`), gated by the
 * single owner-only Cloudflare Access app + its one cookie. This server route
 * forwards every `/api/*` request — plain JSON *and* the long-lived SSE stream —
 * to the tunnel-fronted backend (`api.<domain>`), authenticating to that
 * still-Access-gated host with a Cloudflare Access SERVICE TOKEN. That removes
 * the cross-origin Access trap (a separate `api.<domain>` cookie the browser
 * never holds → every direct fetch 302'd to the login → "offline").
 *
 * SSE works because Workers have no hard duration limit on a streamed response
 * (CPU time excludes time spent waiting; the upstream `: ka` keepalive beats the
 * 100s idle timeout) — returning the upstream Response's body streams it through.
 *
 * Runtime config (Worker bindings; injected at deploy, never committed):
 *   BACKEND_API_BASE        e.g. https://api.dev.hire.<apex> (the tunnel host)
 *   CF_ACCESS_CLIENT_ID     the Access service-token id
 *   CF_ACCESS_CLIENT_SECRET the Access service-token secret
 * Read via the `cloudflare:workers` env binding (per-request safe on edge SSR).
 */

type ProxyEnv = {
  BACKEND_API_BASE?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

// Hop-by-hop / origin-specific headers we must not forward upstream.
const STRIP_REQUEST_HEADERS = ['host', 'cookie', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-host', 'content-length']

async function proxy(request: Request): Promise<Response> {
  const e = env as ProxyEnv
  const base = e.BACKEND_API_BASE
  if (!base) {
    return new Response(JSON.stringify({ error: 'backend_unconfigured', message: 'BACKEND_API_BASE is not set' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(request.url)
  const target = base.replace(/\/$/, '') + url.pathname + url.search

  const headers = new Headers(request.headers)
  for (const h of STRIP_REQUEST_HEADERS) headers.delete(h)
  // Machine-auth to the Access-gated tunnel host (the path D9 reserved).
  if (e.CF_ACCESS_CLIENT_ID) headers.set('CF-Access-Client-Id', e.CF_ACCESS_CLIENT_ID)
  if (e.CF_ACCESS_CLIENT_SECRET) headers.set('CF-Access-Client-Secret', e.CF_ACCESS_CLIENT_SECRET)

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual', // a 302 here = an Access challenge (token rejected); surface it, don't follow
    // Streaming a request body on Workers requires the half-duplex hint.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit)

  // Stream the upstream response straight through (JSON or text/event-stream).
  // Strip the upstream CORS headers — same-origin now, they're moot/confusing.
  const out = new Headers(res.headers)
  out.delete('access-control-allow-origin')
  out.delete('access-control-allow-credentials')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => proxy(request),
      POST: ({ request }) => proxy(request),
      PUT: ({ request }) => proxy(request),
      PATCH: ({ request }) => proxy(request),
      DELETE: ({ request }) => proxy(request),
      OPTIONS: ({ request }) => proxy(request),
    },
  },
})
