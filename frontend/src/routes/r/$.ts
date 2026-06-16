import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

/**
 * BFF attribution-redirect proxy — `/r/*` (STRATEGY §24.74).
 *
 * A minted `/r/<code>` short link (carried in a forwarded résumé footer or an
 * outreach email) is opened by the visitor against this Worker origin. We proxy
 * it to the tunnel-fronted backend with the Access service token (same posture
 * as `/api/*`) — and, because the DB lives backend-side, not at the edge
 * (§24.70 D4), we ENRICH the request with the CF-derived signals the backend
 * records: the client IP (hashed host-side with the secret salt), the coarse
 * country, plus the referrer + user-agent the request already carries. The
 * backend resolves the code, records one first-party visit, and 302s to '/'; we
 * pass that redirect straight back. Any failure still lands the visitor on '/'.
 */

type ProxyEnv = {
  BACKEND_API_BASE?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

// Hop-by-hop / origin-specific headers we never forward, plus the client-supplied
// `x-cp-*` enrichment headers — we strip then re-set them from CF below so a
// visitor can't spoof their own IP/country into the visit row.
const STRIP_REQUEST_HEADERS = [
  'host',
  'cookie',
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-host',
  'content-length',
  'cf-access-jwt-assertion',
  'x-cp-client-ip',
  'x-cp-country',
]

/** A safe always-lands-somewhere fallback when the backend is unreachable. */
function homeRedirect(): Response {
  return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } })
}

async function proxyRedirect(request: Request): Promise<Response> {
  const e = env as ProxyEnv
  const base = e.BACKEND_API_BASE
  if (!base) return homeRedirect()

  const url = new URL(request.url)
  const target = base.replace(/\/$/, '') + url.pathname + url.search

  const headers = new Headers(request.headers)
  for (const h of STRIP_REQUEST_HEADERS) headers.delete(h)
  if (e.CF_ACCESS_CLIENT_ID) headers.set('CF-Access-Client-Id', e.CF_ACCESS_CLIENT_ID)
  if (e.CF_ACCESS_CLIENT_SECRET) headers.set('CF-Access-Client-Secret', e.CF_ACCESS_CLIENT_SECRET)

  // CF-derived signals the backend's visit_telemetry records (set from CF only).
  const clientIp = request.headers.get('cf-connecting-ip')
  if (clientIp) headers.set('x-cp-client-ip', clientIp)
  const cf = (request as unknown as { cf?: { country?: string } }).cf
  const country = cf?.country ?? request.headers.get('cf-ipcountry')
  if (country) headers.set('x-cp-country', country)

  let res: Response
  try {
    res = await fetch(target, { method: 'GET', headers, redirect: 'manual' })
  } catch {
    return homeRedirect()
  }
  if (res.status >= 500) return homeRedirect()

  // Pass the backend's 302 straight through; strip Set-Cookie (the Access-gated
  // backend echoes its service-token cookie — forwarding it would clobber the
  // browser's frontend Access cookie, the same trap documented in `$.ts`).
  const out = new Headers(res.headers)
  out.delete('set-cookie')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export const Route = createFileRoute('/r/$')({
  server: {
    handlers: {
      GET: ({ request }) => proxyRedirect(request),
    },
  },
})
