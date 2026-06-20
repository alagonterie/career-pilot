import type { DevKnobsResponse, HealthFinding } from './use-dev-inspector'
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

// ── §24.138: the control-center panels (Overview / Pipeline / Contacts / System) ──

export type AdminPauseState = 'active' | 'paused' | 'halted' | 'killswitch'
export type AdminTrafficClass = 'ops' | 'chat' | 'sandbox' | 'host'
export interface AdminSpendBucket {
  microusd_24h: number
  buckets: number[]
}

export interface AdminSummary {
  mode: { live_mode: boolean; pause_state: AdminPauseState; pause_reason: string | null; backend: 'online' }
  health: {
    ranAt: string
    counts: Record<string, number>
    worst: string
    /** Only the non-ok findings — each with its concrete next_step. */
    findings: HealthFinding[]
  }
  spendByClass: Record<AdminTrafficClass, AdminSpendBucket>
  spendTotalMicrousd24h: number
  pool: { active: number; capacity: number }
}

export interface AdminPipelineRow {
  application_id: string
  company_name: string | null
  obfuscated_label: string | null
  role_title: string | null
  status: string
  stage: string
  applied_at: string | null
  last_activity_at: string | null
  win_confidence: number | null
}
export interface AdminPipeline {
  applications: AdminPipelineRow[]
  stageCounts: Record<string, number>
}

export interface AdminContact {
  id: string
  name: string | null
  email: string | null
  company: string | null
  role: string | null
  source: string | null
  message: string
  delivered: number
  createdAt: string
}
export interface AdminContactsResponse {
  contacts: AdminContact[]
}

/** Poll the Overview rollup (mode · health · 24h cost · pool). */
export function useAdminSummary(baseUrl: string, pollMs = 20000) {
  return usePolledJson<AdminSummary>(`${baseUrl}/api/admin/summary`, pollMs)
}

/** Poll the owner pipeline view (real company names). */
export function useAdminPipeline(baseUrl: string, pollMs = 20000) {
  return usePolledJson<AdminPipeline>(`${baseUrl}/api/admin/pipeline`, pollMs)
}

/** Poll the §24.121 contact-submissions store. */
export function useAdminContacts(baseUrl: string, pollMs = 20000) {
  return usePolledJson<AdminContactsResponse>(`${baseUrl}/api/admin/contacts`, pollMs)
}

/** Poll the included knob set (registry − ADMIN_DENY). */
export function useAdminKnobs(baseUrl: string, pollMs = 20000) {
  return usePolledJson<DevKnobsResponse>(`${baseUrl}/api/admin/knobs`, pollMs)
}

export interface AdminWriteResult {
  ok: boolean
  status: number
  error?: string
  /** On a 409 set_live_mode, the required-but-missing profile fields. */
  missing?: string[]
}

async function postAdmin(baseUrl: string, body: Record<string, unknown>, path: string): Promise<AdminWriteResult> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed: { error?: string; missing?: string[] } = {}
    try {
      parsed = (await res.json()) as typeof parsed
    } catch {
      // non-JSON body
    }
    if (!res.ok) return { ok: false, status: res.status, error: parsed.error, missing: parsed.missing }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'network error' }
  }
}

/** Write one /admin knob (server enforces the ADMIN_DENY deny-list with a 403). */
export function postAdminKnob(
  baseUrl: string,
  key: string,
  value: boolean | number | string,
): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, { key, value }, '/api/admin/knobs')
}
export function resetAdminKnob(baseUrl: string, key: string): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, { key, reset: true }, '/api/admin/knobs')
}
export function resetAllAdminKnobs(baseUrl: string): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, { resetAll: true }, '/api/admin/knobs')
}

/** Mode controls. Destructive actions (kill-switch, live-mode-on) need `confirm: true`. */
export function postAdminControl(
  baseUrl: string,
  body:
    | { action: 'pause' | 'resume' }
    | { action: 'killswitch'; confirm: true }
    | { action: 'set_live_mode'; on: boolean; confirm?: true },
): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, body, '/api/admin/control')
}
