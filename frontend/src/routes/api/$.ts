import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { guardPublicMutation, type GuardEnv } from '~/lib/edge-guard'

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

// Hop-by-hop / origin-specific headers we must not forward upstream. We also
// strip the inbound `cf-access-jwt-assertion` (the FRONTEND app's assertion CF
// injected for this Worker) so the origin validates only CF's freshly-injected
// API-app assertion (§24.70 D2), never a forwarded wrong-audience one.
const STRIP_REQUEST_HEADERS = [
  'host',
  'cookie',
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-host',
  'content-length',
  'cf-access-jwt-assertion',
]

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
  // Forward the CF-verified client IP for the backend's per-IP simulator cap
  // (§24.70). ALWAYS derive from cf-connecting-ip — never trust a client-supplied
  // x-cp-client-ip (overwrite when CF set one, strip it otherwise) so the cap
  // can't be evaded by rotating a spoofed header.
  const clientIp = request.headers.get('cf-connecting-ip')
  if (clientIp) headers.set('x-cp-client-ip', clientIp)
  else headers.delete('x-cp-client-ip')

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
  const out = new Headers(res.headers)
  // Strip the upstream CORS headers — same-origin now, they're moot/confusing.
  out.delete('access-control-allow-origin')
  out.delete('access-control-allow-credentials')
  // CRITICAL: strip Set-Cookie. The Access-gated backend (api.<domain>) returns
  // its OWN `CF_Authorization` cookie (the service token's JWT — aud = the API
  // Access app) on every response. Forwarding it to the browser overwrites the
  // browser's FRONTEND `CF_Authorization` (aud = the portal app) → the next
  // same-origin /api/* request carries the wrong-audience JWT → the frontend
  // Access app rejects it → 302 to the Access login → panels go "offline" after
  // the first poll. The browser's session is the edge-set frontend cookie ONLY;
  // the Worker→backend auth is the service-token headers, never a browser cookie.
  out.delete('set-cookie')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => proxy(request),
      // Public mutations (`/api/contact`, `/api/simulator`) run the edge guard —
      // Workers-RL burst + Turnstile (§24.70) — before the forward; a non-null
      // result short-circuits with 429/403. Every other POST blind-forwards.
      POST: async ({ request }) => (await guardPublicMutation(request, env as unknown as GuardEnv)) ?? proxy(request),
      PUT: ({ request }) => proxy(request),
      PATCH: ({ request }) => proxy(request),
      DELETE: ({ request }) => proxy(request),
      OPTIONS: ({ request }) => proxy(request),
    },
  },
})
