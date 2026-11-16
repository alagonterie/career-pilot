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
  /** Non-null once retired (§24.177): a soft-stopped owner source keeps its history. */
  expiresAt: string | null
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
  if (artifactType === 'master_pdf') return 'Master résumé'
  if (artifactType === 'owner_source') return 'Named source'
  return artifactType
}

export type AdminAttributionWrite = { action: 'mint'; slug: string } | { action: 'retire'; slug: string }

/** Mint or retire an owner-named visit source (§24.177 D5). Owner-only (404 elsewhere). */
export function postAdminAttribution(baseUrl: string, body: AdminAttributionWrite): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, body, '/api/admin/attribution')
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

// ── §24.164: the owner-only Sandbox-runs view (full detail; the inverse of the
// public metrics-only feed). `ip_token` is a salted hash — never the raw IP. ──
export interface AdminSandboxRun {
  id: string
  ts: string
  visitor_company: string | null
  visitor_role: string | null
  jd_excerpt: string | null
  total_cost_cents: number | null
  total_latency_ms: number | null
  status: 'completed' | 'incomplete'
  expires_at: string | null
  ip_token: string | null
}
export interface AdminSandboxStats {
  total: number
  runsToday: number
  costTodayCents: number
  runs7d: number
}
export interface AdminSandboxRunsView {
  runs: AdminSandboxRun[]
  stats: AdminSandboxStats
}

/** Poll the owner Sandbox-runs feed (real visitor company/role — owner-only). */
export function useAdminSandboxRuns(baseUrl: string, pollMs = 20000) {
  return usePolledJson<AdminSandboxRunsView>(`${baseUrl}/api/admin/sandbox-runs`, pollMs)
}

/** Early-delete one sandbox run (purge its stored input before the TTL). */
export function deleteAdminSandboxRun(baseUrl: string, id: string): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, { id }, '/api/admin/sandbox-runs')
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
  /** The parsed JSON body (success or error) — for actions whose response
   *  carries more than ok/error (§24.200/§24.201: bulk_delete's skip report,
   *  applied_from_lead's undo handle, a 409 duplicate's existing row). */
  data?: Record<string, unknown>
}

async function postAdmin(baseUrl: string, body: Record<string, unknown>, path: string): Promise<AdminWriteResult> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed: { error?: string; missing?: string[] } & Record<string, unknown> = {}
    try {
      const json: unknown = await res.json()
      if (json && typeof json === 'object' && !Array.isArray(json)) parsed = json as typeof parsed
    } catch {
      // non-JSON body
    }
    if (!res.ok) return { ok: false, status: res.status, error: parsed.error, missing: parsed.missing, data: parsed }
    return { ok: true, status: res.status, data: parsed }
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

// ── §24.170: the Persona tab (owner-only candidate-profile editor) ──
export interface AdminPersona {
  /** Editable fields, raw stored values (array fields are JSON-array strings). */
  fields: Record<string, unknown>
  /** Fields shown read-only (e.g. gmail_account — OAuth/OneCLI-managed). */
  readonlyFields: string[]
  /** The work-profile + its HONEST provenance (source / generated_at). */
  workProfile: { json: string | null; source: string | null; generated_at: string | null }
  /** The markdown the agent receives on its next session (renderPersona). */
  personaPreview: string
  /** Required-but-missing fields blocking LIVE mode (empty → ready). */
  blockers: string[]
}

/** Poll the owner candidate-profile editor view. */
export function useAdminPersona(baseUrl: string, pollMs = 30000) {
  return usePolledJson<AdminPersona>(`${baseUrl}/api/admin/persona`, pollMs)
}

/** Write one candidate_profile field (server normalizes + allow-lists; work_profile_json
 * is validated + stored source='manual'). */
export function postAdminPersona(baseUrl: string, field: string, value: unknown): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, { field, value }, '/api/admin/persona')
}

// ── §24.173: the Leads tab (the job_leads world-model — inspect + triage) ──
export interface AdminLead {
  id: string
  source: string
  source_url: string
  apply_url: string | null
  /** §24.190 — how direct `apply_url` is. `aggregator` also means the company
   *  name is unverified (least reliable on a reposted listing). */
  apply_link_kind: 'company' | 'ats' | 'aggregator' | 'unknown' | null
  title: string
  company: string
  company_domain: string | null
  location_raw: string | null
  is_remote: number | null
  workplace_type: string | null
  comp_min_usd: number | null
  comp_max_usd: number | null
  comp_currency: string | null
  comp_period: string | null
  rules_score: number | null
  /** The parsed rules_score reasons breakdown (keyword/comp/location/recency/source). */
  rules_score_reasons: unknown
  llm_score: number | null
  llm_scored_at: string | null
  status: string
  status_changed_at: string
  first_seen_at: string
  last_seen_at: string
  source_posted_at: string | null
  closed_at: string | null
  closed_reason: string | null
  killer_match_pushed_at: string | null
  application_id: string | null
  /** ~200-char excerpt of the JD; the full posting is at source_url. */
  snippet: string | null
}
export interface AdminLeadsRollup {
  activeTotal: number
  closedTotal: number
  byStatus: Record<string, number>
  bySource: Record<string, number>
  llmScored: number
  pushed24h: number
  added24h: number
  added7d: number
  newestAgeHours: number | null
}
export interface AdminLeadsView {
  rollup: AdminLeadsRollup
  leads: AdminLead[]
  closed: AdminLead[]
  /** §24.201 D4 — the owner's excluded titles (whole-title, case-insensitive).
   *  Optional on the client: a host without the list omits it (= empty). */
  titleBlocklist?: string[]
}

/** Poll the owner job-leads world-model (real company names — owner-only). */
export function useAdminLeads(baseUrl: string, pollMs = 20000) {
  return usePolledJson<AdminLeadsView>(`${baseUrl}/api/admin/leads`, pollMs)
}

export type AdminLeadsWrite =
  | { action: 'set_status'; id: string; status: string; reason?: string }
  | { action: 'rescore'; id: string }
  | { action: 'rescore_all' }
  // §24.187 batch cleanup — the ids are exactly the rows the filter is showing
  // (WYSIWYG: the server never re-derives the selection).
  | { action: 'bulk_set_status'; ids: string[]; status: string; reason?: string }
  | { action: 'bulk_delete'; ids: string[]; confirm: true }
  // §24.201 D4 — archive + a tombstone whose reach follows the reason.
  | { action: 'not_interested'; id: string; reason: NotInterestedReason; exclude_title?: boolean }
  // The undo of "exclude this title" — the response carries the updated list.
  | { action: 'title_blocklist_remove'; title: string }
  // §24.201 D8 — create the application and the lead link atomically.
  | {
      action: 'applied_from_lead'
      lead_id: string
      applied_at?: string
      note?: string
      tailored_resume_id?: string
      confirm_duplicate?: boolean
    }
  | { action: 'undo_applied'; application_id: string }

/** Triage / re-score / batch-clean leads (server allow-lists the status set + the
 * action enum, caps the batch size, and confirm-gates the hard delete). */
export function postAdminLeads(baseUrl: string, body: AdminLeadsWrite): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, body, '/api/admin/leads')
}

// ── §24.200 / §24.201: the triage + "I applied" response shapes ──────────────

export const NOT_INTERESTED_REASONS = ['role', 'level', 'location', 'company', 'other'] as const
export type NotInterestedReason = (typeof NOT_INTERESTED_REASONS)[number]

/** bulk_delete's success body. The skip report is additive — an older host
 *  omits it, so every field is optional on the client. */
export interface BulkDeleteResult {
  ok?: boolean
  deleted?: number
  skipped?: number
  // The host's only skip reasons. A lead with a tailored résumé is NOT skipped —
  // its tailored_resumes rows are deleted with it (ON DELETE CASCADE, §24.191 D4).
  skipped_by_reason?: { promoted?: number; email_linked?: number }
}

/** bulk_set_status's success body. `skipped` / `skipped_by_reason` are additive
 *  (a host that archives promoted leads too omits them). */
export interface BulkSetStatusResult {
  ok?: boolean
  updated?: number
  missing?: number
  skipped?: number
  skipped_by_reason?: { promoted?: number }
}

/** The refusal a single-lead write gets (409) when the lead already backs an
 *  application — that row is the Pipeline's to change now. */
export function isPromotedRefusal(res: AdminWriteResult): boolean {
  return !res.ok && res.status === 409 && res.error === 'promoted'
}

export interface NotInterestedResult {
  ok: true
  id: string
  /** `fingerprint` also refuses a near-identical re-post from the same company. */
  tombstone_match: 'id' | 'fingerprint'
  title_blocklisted: boolean
  /** The owner's title blocklist after this write (absent on an older host). */
  title_blocklist?: string[]
}

export interface AppliedFromLeadResult {
  ok: true
  application_id: string
  obfuscated_label: string
  lead_id: string
  prior_status: string
  /** ISO timestamp — Undo is offered until then. */
  undo_until: string
}

export interface DuplicateApplication {
  id: string
  company_name: string | null
  role_title: string | null
  status: string
}

export type AppliedFromLeadOutcome =
  | { kind: 'ok'; result: AppliedFromLeadResult }
  | { kind: 'duplicate'; duplicate_of: DuplicateApplication }
  | { kind: 'already_linked' }
  | { kind: 'not_found' }
  | { kind: 'error'; status: number; error: string }

/** "I applied" (§24.201 D8). Maps the contract's 409/404/400 shapes to a
 *  discriminated outcome so the caller never parses status codes. */
export async function postAppliedFromLead(
  baseUrl: string,
  body: Omit<Extract<AdminLeadsWrite, { action: 'applied_from_lead' }>, 'action'>,
): Promise<AppliedFromLeadOutcome> {
  const res = await postAdminLeads(baseUrl, { action: 'applied_from_lead', ...body })
  if (res.ok) return { kind: 'ok', result: res.data as unknown as AppliedFromLeadResult }
  if (res.status === 409 && res.error === 'duplicate' && res.data?.duplicate_of) {
    return { kind: 'duplicate', duplicate_of: res.data.duplicate_of as DuplicateApplication }
  }
  if (res.status === 409 && res.error === 'already_linked') return { kind: 'already_linked' }
  if (res.status === 404) return { kind: 'not_found' }
  return { kind: 'error', status: res.status, error: res.error ?? `failed (${res.status})` }
}

export type UndoAppliedOutcome =
  | { kind: 'ok'; lead_id: string; restored_status: string }
  | { kind: 'window_passed' }
  | { kind: 'referenced'; detail: string | null }
  | { kind: 'error'; status: number; error: string }

/** Undo an "I applied" inside its window. Refused once the window has passed or
 *  any other row already references the application. */
export async function postUndoApplied(baseUrl: string, applicationId: string): Promise<UndoAppliedOutcome> {
  const res = await postAdminLeads(baseUrl, { action: 'undo_applied', application_id: applicationId })
  if (res.ok) {
    return {
      kind: 'ok',
      lead_id: String(res.data?.lead_id ?? ''),
      restored_status: String(res.data?.restored_status ?? ''),
    }
  }
  if (res.status === 409 && res.error === 'undo_window_passed') return { kind: 'window_passed' }
  if (res.status === 409 && res.error === 'referenced') {
    return { kind: 'referenced', detail: typeof res.data?.detail === 'string' ? res.data.detail : null }
  }
  return { kind: 'error', status: res.status, error: res.error ?? `failed (${res.status})` }
}

// ── §24.191: per-lead résumé tailoring ────────────────────────────────────────

/** One tailoring run. `bio_outcome` is surfaced rather than merely logged: on a
 *  résumé going to a named employer, a bio floored back to the master is the
 *  difference between "tailored" and "my master résumé, reordered". */
export interface TailoredRun {
  id: string
  lead_id: string
  created_at: string
  completed_at: string | null
  status: 'pending' | 'ready' | 'failed'
  jd_used: string | null
  notes: string | null
  bio_outcome: 'tailored' | 'fallback_stub' | 'fallback_unverified_number' | null
  model: string | null
  cost_cents: number | null
  error: string | null
  source_slug: string | null
  has_resume: boolean
}

/** This lead's tailoring runs, newest first. Also the poll target while one is
 *  pending. Returns [] on any failure — the panel degrades to "none yet". */
export async function fetchTailoredRuns(baseUrl: string, leadId: string): Promise<TailoredRun[]> {
  try {
    const res = await fetch(`${baseUrl}/api/admin/leads/${encodeURIComponent(leadId)}/tailored`)
    if (!res.ok) return []
    const body = (await res.json()) as { runs?: TailoredRun[] }
    return body.runs ?? []
  } catch {
    return []
  }
}

/** Start a tailoring run. 409 `already_generating` means a live run already holds
 *  the lock — the caller should poll rather than retry. */
export function startTailoredRun(
  baseUrl: string,
  leadId: string,
  body: { jd?: string; notes?: string; attribute?: boolean },
): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, body, `/api/admin/leads/${encodeURIComponent(leadId)}/tailor`)
}

/** Where the rendered PDF lives (owner-gated; never a public route). */
export function tailoredPdfUrl(baseUrl: string, runId: string): string {
  return `${baseUrl}/api/admin/tailored/${encodeURIComponent(runId)}/resume.pdf`
}
