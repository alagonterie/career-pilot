/**
 * Edge abuse-guard for the public mutation endpoints (STRATEGY §24.70 / 9.4a).
 *
 * Under the §24.39 D12 topology the browser talks ONLY to the Worker, so the
 * Worker BFF proxy (`routes/api/$.ts`) is the only place that sees a raw visitor
 * request before it crosses the tunnel. This module is the guard the proxy runs
 * for the two public mutations — `POST /api/contact` and `POST /api/simulator` —
 * BEFORE forwarding: a Workers-Rate-Limiting burst check, then Turnstile
 * siteverify. Everything else the proxy blind-forwards unchanged.
 *
 * Kept as pure functions (request + env in, Response-or-null out) so the logic is
 * unit-testable without the route/`cloudflare:workers` env machinery. The
 * Durable-Object $-budget + per-IP caps (Commit 3) slot in after Turnstile for
 * the simulator path.
 */

/** The Workers Rate Limiting binding surface we use (`env.<NAME>.limit`). */
export interface RateLimit {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

export interface GuardEnv {
  TURNSTILE_SECRET?: string
  /** When set (prod), siteverify additionally asserts hostname + action. Unset
   * (dev's always-pass test secret) → success:true is sufficient. */
  TURNSTILE_HOSTNAME?: string
  SANDBOX_BURST?: RateLimit
  CONTACT_BURST?: RateLimit
  VISIT_BURST?: RateLimit
}

/** Per-path guard rule: which RL binding + the expected Turnstile action. */
const GUARDED: Record<string, { rl: keyof Pick<GuardEnv, 'SANDBOX_BURST' | 'CONTACT_BURST'>; action: string }> = {
  '/api/simulator': { rl: 'SANDBOX_BURST', action: 'simulator_run' },
  '/api/contact': { rl: 'CONTACT_BURST', action: 'contact_submit' },
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Verify a Turnstile token server-side. `success` is always required; the
 * hostname + action are asserted only in ENFORCE mode (a real `hostname` is
 * passed) — dev's documented always-pass test secret returns success:true but no
 * meaningful hostname/action, so gating those on dev would wrongly reject it.
 * Never throws — a network/parse failure is a verification failure (fail-closed).
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
  hostname: string,
  action: string,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token, remoteip: ip, idempotency_key: crypto.randomUUID() })
  let data: { success?: boolean; hostname?: string; action?: string }
  try {
    const r = await fetch(SITEVERIFY_URL, { method: 'POST', body })
    data = (await r.json()) as typeof data
  } catch {
    return false
  }
  if (!data.success) return false
  if (hostname) {
    if (data.hostname !== hostname) return false
    // The widget sets the action; the token echoes it. Assert when both present.
    if (action && data.action && data.action !== action) return false
  }
  return true
}

/**
 * Guard a request bound for a public mutation. Returns a 429/403 Response to
 * short-circuit, or `null` to let the proxy forward it. Reads only headers (never
 * the body — Turnstile rides the `x-turnstile-token` header) so the proxy can
 * still stream `request.body` afterward. Degrades gracefully: a missing RL
 * binding or unset Turnstile secret (local dev / tests) skips that layer.
 */
export async function guardPublicMutation(request: Request, env: GuardEnv): Promise<Response | null> {
  if (request.method !== 'POST') return null
  const { pathname } = new URL(request.url)
  const rule = GUARDED[pathname]
  if (!rule) return null

  const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0'

  // 1. Workers Rate Limiting burst (per-IP, 60 s window). Fail-open if the
  //    binding is absent (local/test) or errors — Turnstile + the DO caps are the
  //    load-bearing gates; the burst layer is shedding, not the perimeter.
  const limiter = env[rule.rl]
  if (limiter) {
    try {
      const { success } = await limiter.limit({ key: ip })
      if (!success)
        return jsonResponse(429, { error: 'rate_limited', message: 'Too many requests — try again in a minute.' })
    } catch {
      /* fail-open on limiter error */
    }
  }

  // 2. Turnstile siteverify (only when a secret is configured; local dev skips).
  if (env.TURNSTILE_SECRET) {
    const token = request.headers.get('x-turnstile-token') ?? ''
    const ok = token
      ? await verifyTurnstile(env.TURNSTILE_SECRET, token, ip, env.TURNSTILE_HOSTNAME ?? '', rule.action)
      : false
    if (!ok)
      return jsonResponse(403, {
        error: 'turnstile_failed',
        message: 'Could not verify you are human. Reload and try again.',
      })
  }

  return null
}

/**
 * Guard the first-party visit beacon (`POST /api/visit`, §24.177 D3). RL-ONLY —
 * deliberately NO Turnstile: the beacon fires automatically on a normal page load
 * (no widget, no token), so challenging it would reject every legit visit. A
 * per-IP Workers-RL burst sheds floods at the edge; the load-bearing honesty
 * guard is the backend's windowed (slug, ip_hash) write-dedup. Returns a 429 to
 * short-circuit, or null to forward. Fail-open if the binding is absent
 * (local/test) — there's no spend at stake on this path.
 */
export async function guardVisitBeacon(request: Request, env: GuardEnv): Promise<Response | null> {
  if (request.method !== 'POST') return null
  if (new URL(request.url).pathname !== '/api/visit') return null
  const limiter = env.VISIT_BURST
  if (!limiter) return null
  const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0'
  try {
    const { success } = await limiter.limit({ key: ip })
    if (!success)
      return jsonResponse(429, { error: 'rate_limited', message: 'Too many requests — try again in a minute.' })
  } catch {
    /* fail-open on limiter error */
  }
  return null
}
