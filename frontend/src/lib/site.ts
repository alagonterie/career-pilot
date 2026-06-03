/**
 * Shared site constants. The repo is generic-by-design (career-pilot is meant
 * to be forkable) — the placeholder `janedoe` owner matches the work-profile
 * links and the persona used across the public repo.
 */
export const REPO_URL = 'https://github.com/janedoe/career-pilot'

/** The public origin (generic placeholder — the real domain is set at deploy).
 * Used to build absolute og:url / og:image URLs (social scrapers require them). */
export const SITE_URL = 'https://hire.example.com'

/** A line-anchored link into the repo, e.g. `repoBlob('src/modules/portal/api.ts', 222)`. */
export function repoBlob(path: string, line?: number): string {
  return `${REPO_URL}/blob/master/${path}${line != null ? `#L${line}` : ''}`
}
