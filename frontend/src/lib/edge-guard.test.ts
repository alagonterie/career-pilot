import { afterEach, describe, expect, it, vi } from 'vitest'

import { guardPublicMutation, guardVisitBeacon, verifyTurnstile, type GuardEnv, type RateLimit } from './edge-guard'

function siteverifyOnce(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(body) } as unknown as Response))
}

function passRl(): RateLimit {
  return { limit: vi.fn().mockResolvedValue({ success: true }) }
}
function blockRl(): RateLimit {
  return { limit: vi.fn().mockResolvedValue({ success: false }) }
}

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://hire.example.com${path}`, { method: 'POST', headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('verifyTurnstile', () => {
  it('passes on success when no hostname is enforced (dev test-secret path)', async () => {
    siteverifyOnce({ success: true })
    expect(await verifyTurnstile('s', 'tok', '1.2.3.4', '', 'contact_submit')).toBe(true)
  })

  it('fails when the provider says success:false', async () => {
    siteverifyOnce({ success: false, 'error-codes': ['invalid-input-response'] })
    expect(await verifyTurnstile('s', 'tok', '1.2.3.4', 'hire.example.com', 'contact_submit')).toBe(false)
  })

  it('enforces hostname when one is configured (prod)', async () => {
    siteverifyOnce({ success: true, hostname: 'evil.example.com', action: 'contact_submit' })
    expect(await verifyTurnstile('s', 'tok', '1.2.3.4', 'hire.example.com', 'contact_submit')).toBe(false)
  })

  it('passes when hostname + action match in enforce mode', async () => {
    siteverifyOnce({ success: true, hostname: 'hire.example.com', action: 'contact_submit' })
    expect(await verifyTurnstile('s', 'tok', '1.2.3.4', 'hire.example.com', 'contact_submit')).toBe(true)
  })

  it('fail-closes on a network/parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await verifyTurnstile('s', 'tok', '1.2.3.4', '', 'contact_submit')).toBe(false)
  })
})

describe('guardPublicMutation', () => {
  it('ignores non-POST and non-guarded paths (forwards = null)', async () => {
    const env: GuardEnv = { SANDBOX_BURST: passRl(), TURNSTILE_SECRET: 's' }
    expect(await guardPublicMutation(new Request('https://h/api/simulator'), env)).toBeNull()
    expect(await guardPublicMutation(post('/api/pipeline'), env)).toBeNull()
  })

  it('429s when the burst rate-limit is exceeded', async () => {
    const env: GuardEnv = { SANDBOX_BURST: blockRl() }
    const res = await guardPublicMutation(post('/api/simulator'), env)
    expect(res?.status).toBe(429)
    expect(await res?.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('403s when Turnstile verification fails (bad/missing token)', async () => {
    siteverifyOnce({ success: false })
    const env: GuardEnv = { CONTACT_BURST: passRl(), TURNSTILE_SECRET: 's', TURNSTILE_HOSTNAME: 'hire.example.com' }
    const res = await guardPublicMutation(post('/api/contact', { 'x-turnstile-token': 'bad' }), env)
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ error: 'turnstile_failed' })
  })

  it('403s when no token is supplied but a secret is configured', async () => {
    const env: GuardEnv = { CONTACT_BURST: passRl(), TURNSTILE_SECRET: 's' }
    const res = await guardPublicMutation(post('/api/contact'), env)
    expect(res?.status).toBe(403)
  })

  it('forwards (null) when burst passes and Turnstile succeeds', async () => {
    siteverifyOnce({ success: true })
    const env: GuardEnv = { SANDBOX_BURST: passRl(), TURNSTILE_SECRET: 's' }
    expect(await guardPublicMutation(post('/api/simulator', { 'x-turnstile-token': 'ok' }), env)).toBeNull()
  })

  it('fail-opens past a missing RL binding and skips verify with no secret (local dev)', async () => {
    expect(await guardPublicMutation(post('/api/simulator'), {})).toBeNull()
  })
})

describe('guardVisitBeacon (§24.177 — RL-only, no Turnstile)', () => {
  it('ignores non-POST / non-/api/visit paths', async () => {
    const env: GuardEnv = { VISIT_BURST: passRl() }
    expect(await guardVisitBeacon(new Request('https://h/api/visit'), env)).toBeNull()
    expect(await guardVisitBeacon(post('/api/contact'), env)).toBeNull()
  })

  it('429s when the visit burst is exceeded', async () => {
    const res = await guardVisitBeacon(post('/api/visit'), { VISIT_BURST: blockRl() })
    expect(res?.status).toBe(429)
    expect(await res?.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('forwards (null) when the burst passes — and NEVER calls Turnstile', async () => {
    siteverifyOnce({ success: false }) // would 403 if it were consulted
    expect(await guardVisitBeacon(post('/api/visit'), { VISIT_BURST: passRl(), TURNSTILE_SECRET: 's' })).toBeNull()
  })

  it('fail-opens past a missing binding (local dev)', async () => {
    expect(await guardVisitBeacon(post('/api/visit'), {})).toBeNull()
  })
})
