/**
 * src/modules/portal/access-jwt.ts — origin-side Cloudflare Access JWT validation
 * (STRATEGY §24.70 / 9.4a, D2). The applicable Layer-3 defense-in-depth for our
 * cloudflared-tunnel topology (Authenticated Origin Pulls / mTLS does NOT apply —
 * there is no public origin to pull from; the VM binds 127.0.0.1 and the tunnel
 * dials outbound).
 *
 * Cloudflare Access injects a `Cf-Access-Jwt-Assertion` header on every request it
 * lets through the `api.<host>` app — for the Worker's service-token policy, that
 * assertion's `aud` is the api app. Verifying it here catches anything that
 * somehow reached the loopback port without passing Access (a tunnel misconfig, a
 * local SSRF). The tunnel + loopback-bind is the primary isolation; this is the
 * belt.
 *
 * ENV-GATED, fail-safe: active only when `origin_jwt_validation_enabled` AND both
 * `CF_ACCESS_TEAM` + `CF_ACCESS_AUD` are set (deployed stacks). Local dev / tests
 * / an unconfigured stack skip it entirely (validate returns true). Never throws.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

// Cached remote JWKS (keys rotate ~6 weeks with overlap — never hard-code; the
// set re-fetches as needed). Re-created if the team identifier ever changes.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeam: string | null = null;

function getJwks(team: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksTeam !== team) {
    jwks = createRemoteJWKSet(new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`));
    jwksTeam = team;
  }
  return jwks;
}

/** True only when validation is switched on AND the team + audience are configured. */
export function originJwtEnabled(): boolean {
  let enabled = false;
  try {
    enabled = getConfig<boolean>(getDb(), 'origin_jwt_validation_enabled', false);
  } catch {
    enabled = false;
  }
  return enabled && !!process.env.CF_ACCESS_TEAM && !!process.env.CF_ACCESS_AUD;
}

/**
 * Validate the `Cf-Access-Jwt-Assertion` on an inbound request. Returns true when
 * the assertion verifies against the team JWKS with the expected issuer +
 * audience; false otherwise. When validation is disabled/unconfigured (local,
 * tests, pre-cutover), returns true (skip). Never throws.
 */
export async function validateAccessJwt(token: string | undefined): Promise<boolean> {
  if (!originJwtEnabled()) return true; // disabled → pass-through
  if (!token) return false;
  const team = process.env.CF_ACCESS_TEAM as string;
  const aud = process.env.CF_ACCESS_AUD as string;
  try {
    await jwtVerify(token, getJwks(team), {
      issuer: `https://${team}.cloudflareaccess.com`,
      audience: aud,
    });
    return true;
  } catch (err) {
    log.warn('origin Access JWT validation failed', { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
