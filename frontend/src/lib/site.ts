/**
 * Shared site constants. These are per-DEPLOYMENT, not per-candidate: the fork's
 * public repo + the public origin. Set at build time via env (STRATEGY §24.71
 * 9.4b-3) so a fork/deploy points them at its own values; the generic `janedoe`
 * / `example.com` placeholders are the forkable defaults committed to the repo.
 * (Per-candidate identity — email, social profiles — is DB-sourced + SSR'd via
 * `/api/profile`, not here.)
 */
export const REPO_URL =
  (import.meta.env.VITE_REPO_URL as string | undefined) ?? 'https://github.com/janedoe/career-pilot'

/** The public origin. Used to build absolute og:url / og:image URLs (social
 * scrapers require them) — so it must resolve at build/SSR time, hence env. */
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) ?? 'https://hire.example.com'

/** The candidate's name — the brand wordmark, the suffix on ops page <title>s,
 * and the `/architecture` owner-node label. Build-time like the URLs above (it's
 * on the brand chrome, rendered before any `/api/profile` fetch); this is THE
 * single source for the name (STRATEGY §9 line ~1500 / §24.71 9.4b-3), so the
 * placeholder can never leak again from a forgotten hardcode. The richer
 * per-candidate facts (email, socials) stay DB-sourced + SSR'd. */
export const PERSON_NAME = (import.meta.env.VITE_PERSON_NAME as string | undefined) ?? 'Jane Doe'

/** A line-anchored link into the repo, e.g. `repoBlob('src/modules/portal/api.ts', 222)`. */
export function repoBlob(path: string, line?: number): string {
  return `${REPO_URL}/blob/master/${path}${line != null ? `#L${line}` : ''}`
}
