import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { guardPublicMutation, guardVisitBeacon, type GuardEnv } from '~/lib/edge-guard'
import {
  captureStandbySnapshot,
  dispatchStandbyWorkflow,
  readStandbyState,
  readStandbyView,
  writeStandbyState,
} from '~/lib/standby-kv'

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
  // Re-derived from CF below (never trust a client-supplied geo on the visit beacon).
  'x-cp-client-ip',
  'x-cp-country',
]

// ── §24.189: the standby control plane, handled AT THE EDGE ──────────────────
//
// `/api/admin/standby` is the one API path that must work when the origin is
// stopped, so it is answered here rather than proxied. It inherits the SAME
// owner-only Cloudflare Access app that already covers `hire.<apex>/admin` +
// `/api/admin` (enforced at the edge, before this Worker runs) — the host-side
// `adminEnabled()` belt guarding every other admin route can't answer with the
// host off, which is exactly why this endpoint doesn't depend on it.

const STANDBY_PATH = '/api/admin/standby'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function handleStandbyGet(): Promise<Response> {
  return jsonResponse(await readStandbyView(), 200)
}

async function handleStandbyPost(request: Request): Promise<Response> {
  let body: { action?: unknown; note?: unknown; confirm?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse({ error: 'expected a JSON object { action }' }, 400)
  }
  // Both transitions are destructive-ish (one stops a VM, one starts a billing
  // clock), so both are confirm-gated — the same rule the host mode controls use.
  if (body.confirm !== true) {
    return jsonResponse({ error: 'standby transitions require { confirm: true }' }, 400)
  }

  if (body.action === 'enter') {
    // Snapshot identity FIRST, while the backend is still up — it's the only
    // moment the data is reachable, and without it the standby page would render
    // the committed placeholder. A failure is reported, not fatal (§24.189 D6).
    const snapshotOk = await captureStandbySnapshot()
    // Then flip the flag BEFORE the teardown, so no visitor sees a half-dead site.
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
    const written = await writeStandbyState({ mode: 'standby', note, vm: 'stopping' })
    if (!written) return jsonResponse({ error: 'STANDBY_KV is not bound on this Worker' }, 503)
    const dispatch = await dispatchStandbyWorkflow('stop')
    return jsonResponse(
      {
        ok: true,
        mode: 'standby',
        snapshotCaptured: snapshotOk,
        // A failed dispatch still leaves the site correctly on standby — the
        // owner can stop the VM by hand. Reported, never silently swallowed.
        dispatched: dispatch.ok,
        dispatchError: dispatch.error ?? null,
      },
      200,
    )
  }

  if (body.action === 'exit') {
    // Deliberately does NOT clear the flag: `standby.yml` clears it only after
    // the box is back and healthy, so the site un-hides when it's actually live
    // rather than the moment the button is pressed (§24.189 D5).
    const dispatch = await dispatchStandbyWorkflow('start')
    if (!dispatch.ok) return jsonResponse({ error: dispatch.error ?? 'dispatch failed' }, 502)
    await writeStandbyState({ mode: 'standby', vm: 'starting' })
    return jsonResponse({ ok: true, mode: 'standby', vm: 'starting', dispatched: true }, 200)
  }

  return jsonResponse({ error: `unknown action: ${String(body.action)}` }, 400)
}

async function proxy(request: Request): Promise<Response> {
  // §24.189 D7: while hibernated there is no tunnel to reach, so answer truthfully
  // at the edge instead of hanging on a connect timeout to a stopped VM.
  const state = await readStandbyState()
  if (state.mode === 'standby') {
    return jsonResponse(
      { error: 'standby', message: 'The system is on standby — the backend is intentionally stopped.' },
      503,
    )
  }

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
  // (§24.70) + the §24.177 visit beacon. ALWAYS derive from cf-connecting-ip —
  // never trust a client-supplied x-cp-client-ip (the strip-list drops any inbound
  // one) so the cap/attribution can't be evaded by rotating a spoofed header.
  const clientIp = request.headers.get('cf-connecting-ip')
  if (clientIp) headers.set('x-cp-client-ip', clientIp)
  // The coarse country the visit beacon records (§24.177) — also CF-derived only.
  const cf = (request as unknown as { cf?: { country?: string } }).cf
  const country = cf?.country ?? request.headers.get('cf-ipcountry')
  if (country) headers.set('x-cp-country', country)

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

/** True for the edge-served standby endpoint (§24.189) — matched exactly so no
 *  other `/api/admin/*` path is diverted from the proxy. */
function isStandbyPath(request: Request): boolean {
  return new URL(request.url).pathname.replace(/\/+$/, '') === STANDBY_PATH
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => (isStandbyPath(request) ? handleStandbyGet() : proxy(request)),
      // Public mutations (`/api/contact`, `/api/simulator`) run the edge guard —
      // Workers-RL burst + Turnstile (§24.70). The visit beacon (`/api/visit`,
      // §24.177) runs an RL-ONLY guard (no Turnstile — it has no widget). A
      // non-null result short-circuits with 429/403; every other POST forwards.
      POST: async ({ request }) => {
        // The standby control plane is edge-served and Access-gated; it must NOT
        // run the public-mutation guard (it isn't a public mutation) and must not
        // be short-circuited by the standby 503 — it's how you get back.
        if (isStandbyPath(request)) return handleStandbyPost(request)
        const e = env as unknown as GuardEnv
        const blocked = (await guardVisitBeacon(request, e)) ?? (await guardPublicMutation(request, e))
        return blocked ?? proxy(request)
      },
      PUT: ({ request }) => proxy(request),
      PATCH: ({ request }) => proxy(request),
      DELETE: ({ request }) => proxy(request),
      OPTIONS: ({ request }) => proxy(request),
    },
  },
})
