import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'

import type { WorkProfile } from './work-profile'

/**
 * SSR loader for the `/work` profile (STRATEGY §24.71 / 9.4b-1).
 *
 * `getWorkProfile` is a server function: its handler runs ONLY on the server
 * (the Worker during SSR, or via RPC on client navigation) and is stripped from
 * the client bundle — so the `cloudflare:workers` env binding never ships to the
 * browser (same isolation `routes/api/$.ts` relies on). It fetches the backend's
 * `GET /api/profile` through the same tunnel host + Access service-token the BFF
 * proxy uses, so the real candidate profile renders in the SSR HTML (replacing
 * the `Jane Doe` placeholder) and the meta tags are correct with JS disabled.
 *
 * The agent composes the page at WRITE-time (§24.71 D1) — this read path does no
 * LLM work. Any failure (unconfigured backend, non-200, malformed) resolves to a
 * null profile, and the route renders the typed placeholder (PORTAL §12).
 */
/**
 * Canonical contact/social identity (§24.71 9.4b-3) — read from candidate_profile
 * columns, always present (fields nullable), the single source for every link the
 * site renders (contact, hero, /work). Omit a link when its field is null.
 */
export interface Identity {
  email: string | null
  github: string | null
  linkedin: string | null
  x: string | null
  website: string | null
}

export interface ProfilePayload {
  /** The composed page, or null → the route falls back to the placeholder. */
  profile: WorkProfile | null
  /** The candidate's canonical contact/social identity (fields nullable). */
  identity: Identity
  /** Provenance for the §24.71 D4 on-page marker (consumed in 9.4b-2). */
  source: string | null
  generatedAt: string | null
}

const EMPTY_IDENTITY: Identity = { email: null, github: null, linkedin: null, x: null, website: null }

type ProfileEnv = {
  BACKEND_API_BASE?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

const EMPTY: ProfilePayload = { profile: null, identity: EMPTY_IDENTITY, source: null, generatedAt: null }

export const getWorkProfile = createServerFn({ method: 'GET' }).handler(async (): Promise<ProfilePayload> => {
  const e = env as ProfileEnv
  // Deployed Worker → the Access-gated tunnel host + the service token (the path
  // the BFF proxy uses). Local dev (no BACKEND_API_BASE) → the loopback backend,
  // no token. Either way a failure degrades to the placeholder, never throws.
  const base = (e.BACKEND_API_BASE ?? 'http://localhost:3001').replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (e.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = e.CF_ACCESS_CLIENT_ID
  if (e.CF_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = e.CF_ACCESS_CLIENT_SECRET

  try {
    const res = await fetch(`${base}/api/profile`, { headers, redirect: 'manual' })
    if (!res.ok) return EMPTY
    const data = (await res.json()) as {
      profile?: WorkProfile | null
      identity?: Identity | null
      source?: string | null
      generated_at?: string | null
    }
    return {
      profile: data.profile ?? null,
      identity: data.identity ?? EMPTY_IDENTITY,
      source: data.source ?? null,
      generatedAt: data.generated_at ?? null,
    }
  } catch {
    return EMPTY
  }
})
