import { usePolledJson } from './use-polled-json'

/**
 * Client types + hook for the owner-only `/admin` attribution browser
 * (`GET /api/admin/attribution`, STRATEGY §24.74 D5). Served on the dev stack
 * (owner-Access-gated) and, post-cutover, the prod `/admin` Access app; 404s on
 * any stack where the admin surface is disabled, so the hook surfaces a cold
 * `'error'` and the page degrades to an "unavailable" note. Read-only.
 */

export interface AdminAttributionLink {
  code: string
  artifactType: string
  company: string | null
  /** Owner-private (the address we cold-emailed) — only ever served behind the admin gate. */
  recipient: string | null
  createdAt: string
  clicks: number
  uniqueVisitors: number
  lastClickAt: string | null
}

export interface AdminAttributionVisit {
  ts: string
  linkCode: string | null
  company: string | null
  country: string | null
  uaClass: string | null
  referrer: string | null
}

export interface AdminAttributionReport {
  links: AdminAttributionLink[]
  recentVisits: AdminAttributionVisit[]
  summary: {
    totalLinks: number
    totalClicks: number
    totalUniqueVisitors: number
    byArtifact: Record<string, number>
    topCountries: { country: string; clicks: number }[]
  }
}

/** Poll the attribution read-model. Cold 404 (admin disabled) → `status: 'error'`. */
export function useAdminAttribution(baseUrl: string, pollMs = 8000) {
  return usePolledJson<AdminAttributionReport>(`${baseUrl}/api/admin/attribution`, pollMs)
}

/** A compact, human label for an artifact type (the link's source). */
export function artifactLabel(artifactType: string): string {
  if (artifactType === 'outreach') return 'Outreach email'
  if (artifactType === 'master_pdf') return 'Résumé PDF'
  return artifactType
}
