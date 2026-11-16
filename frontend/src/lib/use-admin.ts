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
  // ── §24.203: the read-only catch-up. Every field below is optional — an older
  // host omits them all and the tab renders its original five columns. ──
  stage_entered_at?: string | null
  /** Whole days since the row entered its stage (≥ 0), or null when unknown. */
  days_in_stage?: number | null
  /** The scribe's ghosting threshold for this stage; null = never tinted. */
  ghosting_threshold_days?: number | null
  /** days_in_stage is at or past the threshold (host-computed). */
  ghosting?: boolean
  win_confidence_rationale?: string | null
  lead_ids?: string[]
  posting_url?: string | null
  sent_resume_id?: string | null
  timeline?: PipelineTimelineEvent[]
  narrative?: PipelineNarrative | null
  suggestions?: PipelineSuggestion[]
  /** Ordered same_day, action_owed, fyi. */
  attention?: PipelineAttentionItem[]
  /** attention[0]?.priority ?? null — the chip and its sort key. */
  attention_top?: ScribePriority | null
  last_email?: PipelineLastEmail | null
  learnings?: PipelineLearning[]
  kits?: PipelineKit[]
  active_kit_url?: string | null
  tailored_resumes?: PipelineTailoredResume[]
}
export interface AdminPipeline {
  applications: AdminPipelineRow[]
  stageCounts: Record<string, number>
  /** §24.203: the scribe's ghosting thresholds, e.g. { applied: 21, screen: 10, onsite: 7 }. */
  ghostingThresholdsDays?: Record<string, number>
  /** §24.203: stage → threshold key (stages without one are never tinted). */
  ghostingStageMap?: Record<string, string>
  /** §24.203: the latest scribe run, or null when it has never run. */
  scribe?: {
    run_at: string
    /** Attention items with no application (company-only), shown above the table. */
    attention_unlinked: PipelineUnlinkedAttention[]
  } | null
}

// ── §24.203: what the owner Pipeline tab shows in a row's detail ─────────────

export type ScribePriority = 'same_day' | 'action_owed' | 'fyi'

export interface PipelineTimelineEvent {
  id: string
  ts: string
  kind: string
  from_status: string | null
  to_status: string | null
  source: string
  summary: string | null
}
export interface PipelineNarrative {
  current_state: string
  last_event_at: string | null
  timeline_excerpt: string[]
}
export interface PipelineAttentionItem {
  priority: ScribePriority
  reason: string
  hint: string | null
}
export interface PipelineUnlinkedAttention extends PipelineAttentionItem {
  company: string | null
}
export interface PipelineSuggestion {
  action: string
  rationale: string
  evidence_msg_id: string | null
}
export interface PipelineLastEmail {
  at: string
  subject: string | null
  from_addr: string | null
  classification: string
  thread_id: string
  thread_url: string
}
export interface PipelineLearning {
  id: string
  kind: string
  created_at: string
  published: boolean
  text: string
}
export interface PipelineKit {
  round: string
  interview_type: string
  title: string
  drive_url: string
  status: 'active' | 'archived'
  interview_at: string | null
  created_at: string
}
export interface PipelineTailoredResume {
  id: string
  lead_id: string
  created_at: string
  bio_outcome: string | null
  sent: boolean
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
  /** §24.202 — this lead's agent actions (the in-flight lock + newest per kind).
   *  Absent on a host without agent actions. */
  actions?: LeadActionsSummary
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
  /** §24.200 D5/D8 — the direct-board sweep and the search supplement. Optional
   *  on the client: a host without the sweep omits it and the strip is hidden. */
  sourcing?: AdminLeadsSourcing
  /** §24.202 — the agent-action switches (pause state, daily cap, Run now).
   *  Absent on a host without agent actions, which hides every action button. */
  agentActions?: AgentActionsMeta
}

/** One `lead_source_runs` row — a single direct-board sweep (§24.200 D5). */
export interface LeadSweepRun {
  id: string
  started_at: string
  /** Typed nullable defensively: a run row may be read before it finishes. */
  finished_at: string | null
  ok: boolean
  trigger: 'schedule' | 'manual'
  boards_ok: number
  boards_failed: number
  new: number
  refreshed: number
  closed: number
  reopened: number
  /** Postings the sweep did not insert, by reason (filter, age, tombstone, cap…). */
  rejected: Record<string, number>
  failing_boards: { company: string; ats: string; error: string }[]
}

export interface AdminLeadsSourcing {
  lastSweep: LeadSweepRun | null
  sweepRunning: boolean
  /** The last search-index run: what the insert guard refused, by reason and by
   *  the reposting site it came from. */
  lastSearch: {
    at: string
    rejected: Record<string, number>
    rejected_by_site: Record<string, number>
  } | null
  searchQuota: {
    used_period: number
    monthly_quota: number
    used_today: number
    daily_cap: number
    period_start: string
  }
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
  // `block_company` (§24.200 slice b) also pauses that company's watchlist board.
  | {
      action: 'not_interested'
      id: string
      reason: NotInterestedReason
      exclude_title?: boolean
      block_company?: boolean
    }
  // §24.201 D6 — start a direct-board sweep now (detached; the poll shows it).
  | { action: 'sweep_now' }
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
  // §24.201 D7 — a Greenhouse / Lever / Ashby posting link (see postAddLeadByUrl).
  | { action: 'add_lead_by_url'; url: string; company?: string }

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
  // §24.202 adds `action_in_flight`: a lead with a queued or running agent action.
  skipped_by_reason?: { promoted?: number; email_linked?: number; action_in_flight?: number }
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
  /** Whether `block_company` paused a watchlist board — false when no board on
   *  the watchlist matches the lead's company (absent on an older host). */
  company_blocked?: boolean
}

export type SweepNowOutcome =
  | { kind: 'started' }
  | { kind: 'already_running' }
  | { kind: 'halted' }
  | { kind: 'error'; status: number; error: string }

/** "Sweep now" (§24.201 D6). The sweep is detached on the host: a 202 means it
 *  started, and the regular leads poll picks up the run as it lands. */
export async function postSweepNow(baseUrl: string): Promise<SweepNowOutcome> {
  const res = await postAdminLeads(baseUrl, { action: 'sweep_now' })
  if (res.ok) return { kind: 'started' }
  if (res.status === 409 && res.error === 'already_running') return { kind: 'already_running' }
  if (res.status === 409 && res.error === 'halted') return { kind: 'halted' }
  return { kind: 'error', status: res.status, error: res.error ?? `failed (${res.status})` }
}

export interface AppliedFromLeadResult {
  ok: true
  application_id: string
  obfuscated_label: string
  lead_id: string
  prior_status: string
  /** ISO timestamp — Undo is offered until then. */
  undo_until: string
  /** Applying promotes the lead's ATS board on the watchlist (added as origin
   *  'applied', or its tier raised). null when the lead has no ATS board; absent
   *  on an older host. Undo does not reverse it. */
  board_promotion?: BoardPromotion | null
}

/** What "I applied" did to the lead's watchlist board. */
export interface BoardPromotion {
  action: 'added' | 'tier_raised' | 'unchanged'
  ats: AtsSource
  token: string
  /** The board's tier after the change ('added' / 'tier_raised'). */
  tier?: WatchlistTier
  /** Why nothing changed ('unchanged'): already_top_tier, paused, absent, cap_reached, removed_by_owner. */
  reason?: string
}

/** A one-line note for the "just applied" strip, or null when there is nothing worth saying. */
export function boardPromotionNote(p: BoardPromotion | null | undefined): string | null {
  if (!p) return null
  if (p.action === 'added') return `now watching ${p.token} on ${p.ats} (tier ${p.tier ?? 'B'})`
  if (p.action === 'tier_raised') return `${p.token} board raised to tier ${p.tier ?? '?'}`
  return null
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

// ── §24.201 D6: the Watchlist tab (employer boards the sweep reads) ───────────

export type AtsSource = 'greenhouse' | 'lever' | 'ashby'
export type WatchlistState = 'active' | 'paused' | 'absent'
export type WatchlistOrigin = 'seed' | 'owner' | 'search' | 'applied'
export type WatchlistTier = 'A' | 'B' | 'C'

export interface AdminWatchlistBoard {
  id: number
  ats: AtsSource
  token: string
  company: string
  tier: WatchlistTier
  origin: WatchlistOrigin
  state: WatchlistState
  notes: string | null
  last_ok_at: string | null
  last_error: string | null
  consecutive_failures: number
  consecutive_absent: number
  leads_found: number
  last_hit_at: string | null
  created_at: string
  updated_at: string
  /** Open leads from this board right now. */
  open_leads: number
  /** The board's public page (built by the host from fixed per-ATS hosts). */
  board_url: string
}

export interface AdminWatchlistView {
  boards: AdminWatchlistBoard[]
  /** Optional on the client so a partial body still renders (the table alone). */
  counts?: {
    total: number
    active: number
    paused: number
    absent: number
    by_origin: Partial<Record<WatchlistOrigin, number>>
  }
  caps?: {
    /** ats_watchlist_max_boards */
    max_boards: number
    /** Boards the cap counts (every state except `absent`). */
    counted: number
    /** ats_watchlist_max_auto_adds_per_run */
    max_auto_adds_per_run: number
  }
}

/** The sweep-filter knobs a preview may override; an omitted key keeps the stored value. */
export interface SweepFilterProposal {
  ats_sweep_title_include?: string
  ats_sweep_title_exclude?: string
  ats_sweep_location_filter?: string
  ats_sweep_max_age_days?: number
}
export type SweepDropReason = 'filter' | 'location' | 'age'
export interface SweepFilterCounts {
  keep: number
  drop: number
  drop_by_reason: Partial<Record<SweepDropReason, number>>
}
export interface SweepPreviewLead {
  id: string
  title: string
  company: string
  reason: SweepDropReason | null
}
export interface SweepFilterPreview {
  ok: true
  /** Open board leads measured. */
  total: number
  current: SweepFilterCounts
  proposed: SweepFilterCounts
  newly_dropped: number
  newly_kept: number
  sample_newly_dropped: SweepPreviewLead[]
  sample_newly_kept: SweepPreviewLead[]
}

export type AdminWatchlistWrite =
  | { action: 'add_by_url'; url: string; company?: string; tier?: WatchlistTier }
  | { action: 'set_state'; id: number; state: 'active' | 'paused' }
  | { action: 'remove'; id: number }
  | { action: 'preview_filters'; filters: SweepFilterProposal }

/** Poll the owner watchlist. Cold 404 (a host without it) → `status: 'error'`
 *  and the tab is hidden. */
export function useAdminWatchlist(baseUrl: string, pollMs = 20000) {
  return usePolledJson<AdminWatchlistView>(`${baseUrl}/api/admin/watchlist`, pollMs)
}

/** Every watchlist write (server-enforced under the admin gate). */
export function postAdminWatchlist(baseUrl: string, body: AdminWatchlistWrite): Promise<AdminWriteResult> {
  return postAdmin(baseUrl, body, '/api/admin/watchlist')
}

/** A host that predates an action answers 400 `unknown action: <x>`. */
function isUnknownAction(res: AdminWriteResult): boolean {
  return res.status === 400 && typeof res.error === 'string' && res.error.startsWith('unknown action')
}

/** The plain sentence for a refused admin write. The host's own `message` wins
 *  when it sent one; otherwise the code is put into words here. */
export function adminRefusalMessage(res: AdminWriteResult): string {
  const d = res.data ?? {}
  if (typeof d.message === 'string' && d.message.trim() !== '') return d.message
  if (isUnknownAction(res)) return 'This server does not support that yet — deploy the latest backend first.'
  switch (res.error) {
    case 'already_listed': {
      const b = d.board as Partial<AdminWatchlistBoard> | undefined
      const who = b?.company ?? 'That board'
      return b?.state ? `${who} is already on the watchlist (${b.state}).` : `${who} is already on the watchlist.`
    }
    case 'cap_reached': {
      const cap = typeof d.cap === 'number' ? d.cap : null
      const counted = typeof d.counted === 'number' ? d.counted : null
      const tally = cap != null && counted != null ? ` (${counted} of ${cap} boards)` : ''
      return `The watchlist is full${tally}. Remove a board, or raise the board cap on the System tab.`
    }
    case 'bad_company':
      return 'The company name must be 1–200 characters.'
    case 'bad_tier':
      return 'Tier must be A, B or C.'
    case 'not_found':
      return 'That board is no longer on the watchlist.'
    case 'bad_id':
    case 'bad_state':
      return 'The server refused that change.'
    case 'internal_error':
      return 'The server hit an error, so nothing was changed. Try again; if it keeps happening, check the host logs.'
  }
  // `<table> not migrated` (404): the backend predates this feature.
  if (res.status === 404 && typeof res.error === 'string' && res.error.endsWith(' not migrated')) {
    return 'This server does not support that yet — deploy the latest backend first.'
  }
  if (res.status === 0) return `Network error: ${res.error ?? 'request failed'}`
  return res.error ?? `Request failed (${res.status}).`
}

export type WatchlistAddOutcome =
  | { kind: 'ok'; board: AdminWatchlistBoard; inserted: boolean; reactivated: boolean }
  | { kind: 'refused'; status: number; error: string; message: string }

/** "Add company by URL" — the URL is parsed on the host, never fetched; only the
 *  ATS's own API is asked whether the board exists. */
export async function postWatchlistAddByUrl(
  baseUrl: string,
  body: { url: string; company?: string; tier?: WatchlistTier },
): Promise<WatchlistAddOutcome> {
  const res = await postAdminWatchlist(baseUrl, { action: 'add_by_url', ...body })
  if (res.ok && res.data?.board) {
    return {
      kind: 'ok',
      board: res.data.board as AdminWatchlistBoard,
      inserted: res.data.inserted === true,
      reactivated: res.data.reactivated === true,
    }
  }
  return {
    kind: 'refused',
    status: res.status,
    error: res.error ?? `failed (${res.status})`,
    message: adminRefusalMessage(res),
  }
}

export type SweepPreviewOutcome =
  | { kind: 'ok'; preview: SweepFilterPreview }
  | { kind: 'invalid'; field: string; message: string }
  | { kind: 'unsupported' }
  | { kind: 'error'; status: number; message: string }

/** Preview proposed sweep filters against the open board leads (read-only). */
export async function postSweepPreview(baseUrl: string, filters: SweepFilterProposal): Promise<SweepPreviewOutcome> {
  const res = await postAdminWatchlist(baseUrl, { action: 'preview_filters', filters })
  if (res.ok && res.data && typeof res.data.total === 'number') {
    return { kind: 'ok', preview: res.data as unknown as SweepFilterPreview }
  }
  if (res.status === 400 && res.error === 'invalid_filter') {
    return {
      kind: 'invalid',
      field: typeof res.data?.field === 'string' ? res.data.field : '',
      message: typeof res.data?.message === 'string' ? res.data.message : 'invalid filter',
    }
  }
  if (isUnknownAction(res) || res.status === 404) return { kind: 'unsupported' }
  return { kind: 'error', status: res.status, message: adminRefusalMessage(res) }
}

// ── §24.201 D7: add a lead by its posting URL ─────────────────────────────────

export interface AddLeadByUrlResult {
  ok: true
  lead_id: string
  outcome: 'created' | 'already_present'
  /** The lead's status now (so the UI can say "already in the pool — archived"). */
  lead_status: string
  /** A matching "not interested" tombstone was overridden and deleted. */
  tombstone_cleared: boolean
  /** The posting's board, PROPOSED — never auto-added. */
  board_proposed: {
    ats: AtsSource
    token: string
    company: string
    already_listed: boolean
    state: WatchlistState | null
  }
}

export type AddLeadByUrlOutcome =
  | { kind: 'ok'; result: AddLeadByUrlResult }
  | { kind: 'refused'; status: number; error: string; message: string }

/** "Add lead by URL" (§24.201 D7): a Greenhouse / Lever / Ashby posting link. */
export async function postAddLeadByUrl(baseUrl: string, url: string, company?: string): Promise<AddLeadByUrlOutcome> {
  const trimmed = company?.trim()
  const res = await postAdminLeads(
    baseUrl,
    trimmed ? { action: 'add_lead_by_url', url, company: trimmed } : { action: 'add_lead_by_url', url },
  )
  if (res.ok && res.data && typeof res.data.lead_id === 'string') {
    return { kind: 'ok', result: res.data as unknown as AddLeadByUrlResult }
  }
  return {
    kind: 'refused',
    status: res.status,
    error: res.error ?? `failed (${res.status})`,
    message: adminRefusalMessage(res),
  }
}

// ── §24.202: agent actions — fixed buttons whose results land on the lead ─────

export type AgentActionKind = 'research_company' | 'draft_outreach' | 'build_interview_kit' | 'run_now'
export type LeadActionKind = Exclude<AgentActionKind, 'run_now'>
export type RunNowSeries = 'job_scrape' | 'daily_briefing'
export type AgentActionStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired'

export const LEAD_ACTION_KINDS: readonly LeadActionKind[] = [
  'research_company',
  'draft_outreach',
  'build_interview_kit',
]
export const RUN_NOW_SERIES: readonly RunNowSeries[] = ['job_scrape', 'daily_briefing']

export interface AgentActionRow {
  id: string
  kind: AgentActionKind
  /** run_now only. */
  series: RunNowSeries | null
  /** null after the lead is deleted, and for run_now. */
  lead_id: string | null
  company: string | null
  title: string | null
  application_id: string | null
  /** build_interview_kit only. */
  round: string | null
  note: string | null
  status: AgentActionStatus
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  /** When a still-queued action expires unstarted. */
  expires_at: string
  has_result: boolean
}

export interface OutreachResult {
  subject: string
  body: string
  /** Only when the note named a recipient — otherwise the draft has none. */
  to: string | null
  research_md: string | null
}
export interface KitResult {
  kit_url: string
  title: string
  round: string
}
export type AgentActionResultJson = OutreachResult | KitResult

export interface AgentActionProgress {
  ts: string
  agent: string | null
  text: string
}

export interface AgentActionDetail extends AgentActionRow {
  /** research_company + draft_outreach: the research digest (markdown). */
  result_md: string | null
  result_json: AgentActionResultJson | null
  /** The subagent's progress lines for this action's window, oldest first —
   *  approximate when two tasks share a turn. Optional on the client. */
  progress?: AgentActionProgress[]
}

export interface AgentActionBrief {
  id: string
  status: AgentActionStatus
  created_at: string
  completed_at: string | null
  has_result: boolean
}

export interface LeadActionsSummary {
  /** A queued or running action holds this lead (the one-at-a-time lock). */
  in_flight: boolean
  /** The newest action per kind. */
  latest: Partial<Record<LeadActionKind, AgentActionBrief>>
}

export interface RunNowState {
  in_flight_action_id: string | null
  next_scheduled_at: string | null
  /** The scheduled run is due within `guard_minutes` — Run now is refused. */
  guarded: boolean
}

export interface AgentActionsMeta {
  pause_state: AdminPauseState
  can_enqueue: boolean
  daily_cap: number
  used_today: number
  note_max_chars: number
  ttl_minutes: number
  guard_minutes: number
  /** The Gmail account the compose link opens under; null when unset. */
  compose_authuser: string | null
  run_now: Record<RunNowSeries, RunNowState>
  kit_rounds: string[]
}

export interface AgentActionsList {
  actions: AgentActionRow[]
  meta: AgentActionsMeta
}

export type AdminActionWrite =
  | { action: 'enqueue'; kind: LeadActionKind; lead_id: string; note?: string; round?: string }
  | { action: 'run_now'; series: RunNowSeries }

export type AdminActionOutcome =
  | { kind: 'queued'; action_id: string }
  | { kind: 'refused'; status: number; error: string; data: Record<string, unknown> }

/** queued and running are "in flight": they hold the lock and are polled. */
export function isActionInFlight(status: AgentActionStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running'
}

/** Every agent action, newest first (or one lead's). null when the read fails or
 *  the host has no agent actions. */
export async function fetchAdminActions(baseUrl: string, leadId?: string): Promise<AgentActionsList | null> {
  try {
    const q = leadId ? `?lead_id=${encodeURIComponent(leadId)}` : ''
    const res = await fetch(`${baseUrl}/api/admin/actions${q}`)
    if (!res.ok) return null
    const body = (await res.json()) as Partial<AgentActionsList>
    if (!Array.isArray(body.actions) || !body.meta) return null
    return { actions: body.actions, meta: body.meta }
  } catch {
    return null
  }
}

export type AdminActionRead =
  | { kind: 'ok'; action: AgentActionDetail }
  | { kind: 'not_found' }
  | { kind: 'error'; status: number }

/** One action with its result and progress. A network failure is `error` (the
 *  poll retries); a 404 is `not_found` (the poll stops). */
export async function fetchAdminAction(baseUrl: string, id: string): Promise<AdminActionRead> {
  try {
    const res = await fetch(`${baseUrl}/api/admin/actions/${encodeURIComponent(id)}`)
    if (res.status === 404) return { kind: 'not_found' }
    if (!res.ok) return { kind: 'error', status: res.status }
    const body = (await res.json()) as AgentActionDetail | null
    if (!body || typeof body.id !== 'string' || typeof body.status !== 'string') return { kind: 'error', status: 0 }
    return { kind: 'ok', action: body }
  } catch {
    return { kind: 'error', status: 0 }
  }
}

/** Queue a lead action or a Run now. A 202 is `queued`; everything else is
 *  `refused` with the host's body (render it with `agentActionRefusalMessage`). */
export async function postAdminAction(baseUrl: string, body: AdminActionWrite): Promise<AdminActionOutcome> {
  const res = await postAdmin(baseUrl, body as unknown as Record<string, unknown>, '/api/admin/actions')
  if (res.ok && typeof res.data?.action_id === 'string') return { kind: 'queued', action_id: res.data.action_id }
  return { kind: 'refused', status: res.status, error: res.error ?? `failed (${res.status})`, data: res.data ?? {} }
}

/** The action a 409 `in_flight` / `duplicate` names — the caller follows that
 *  one instead of retrying. */
export function refusalActionId(out: AdminActionOutcome): string | null {
  if (out.kind !== 'refused') return null
  if (out.error !== 'in_flight' && out.error !== 'duplicate') return null
  return typeof out.data.action_id === 'string' ? out.data.action_id : null
}

function fmtLocal(iso: unknown): string | null {
  if (typeof iso !== 'string') return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** SCREENING → "Screening", TECH_SCREEN → "Tech screen". */
export function roundLabel(round: string): string {
  const s = round.toLowerCase().replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A daily cap of 0 is the off switch, not a used-up limit — it never resets. */
export const AGENT_ACTIONS_OFF_MESSAGE =
  'Agent actions are switched off (admin_action_daily_cap is 0 on the System tab).'

/** Plain words for every refusal the actions route returns. */
export function agentActionRefusalMessage(out: Extract<AdminActionOutcome, { kind: 'refused' }>): string {
  const d = out.data
  switch (out.error) {
    case 'agent_actions not migrated':
      return 'This host does not support agent actions yet.'
    case 'bad_kind':
      return 'That action is not one the agent knows.'
    case 'bad_series':
      return 'That schedule cannot be run now.'
    case 'lead_id_required':
      return 'No lead was given.'
    case 'bad_note':
      return 'The note must be plain text.'
    case 'note_too_long':
      return typeof d.max === 'number' ? `The note is too long — at most ${d.max} characters.` : 'The note is too long.'
    case 'unknown_lead':
      return 'That lead no longer exists.'
    case 'not_promoted':
      return typeof d.message === 'string'
        ? d.message
        : 'Interview kits need an application. Mark the lead applied first.'
    case 'bad_round':
      return Array.isArray(d.allowed)
        ? `Pick one of the interview rounds: ${(d.allowed as unknown[]).map((r) => roundLabel(String(r))).join(', ')}.`
        : 'Pick an interview round.'
    case 'not_active': {
      const state = typeof d.pause_state === 'string' ? d.pause_state : 'not active'
      return `The agent is ${state}, so nothing was queued. Resume it on the Overview tab first.`
    }
    case 'in_flight':
      return 'Another agent action for this lead is still queued or running — wait for it to finish.'
    case 'duplicate':
      return 'A run for this schedule is already queued — wait for it to finish.'
    case 'run_now_guard': {
      const when = fmtLocal(d.next_scheduled_at)
      const mins = typeof d.guard_minutes === 'number' ? ` (within ${d.guard_minutes} minutes)` : ''
      return `The scheduled run is due soon${when ? ` — ${when}` : ''}${mins}, so it was not started now.`
    }
    case 'daily_cap': {
      const used = typeof d.used === 'number' ? d.used : null
      const cap = typeof d.cap === 'number' ? d.cap : null
      if (cap === 0) return AGENT_ACTIONS_OFF_MESSAGE
      const count = used != null && cap != null ? ` (${used} of ${cap})` : ''
      return `Today's agent-action limit is used up${count}. It resets at midnight UTC.`
    }
    case 'no_ops_session':
      return 'The agent has no ops session running, so nothing can be queued yet.'
    case 'note_not_supported':
      return 'Interview kits do not take a note. Clear the note and press again.'
    case 'kit_already_queued':
      return 'A kit for that round is already queued and will be built on the next run.'
    case 'enqueue_failed':
      return 'The host could not queue the action. Nothing was started; try again.'
    case 'internal_error':
      return 'The host hit an error, so nothing was queued. Try again; if it keeps happening, check the host logs.'
    default:
      if (out.status === 0) return `Could not reach the server (${out.error}).`
      return out.error
  }
}

export function isOutreachResult(r: AgentActionResultJson | null | undefined): r is OutreachResult {
  return !!r && typeof (r as OutreachResult).subject === 'string' && typeof (r as OutreachResult).body === 'string'
}
export function isKitResult(r: AgentActionResultJson | null | undefined): r is KitResult {
  return !!r && typeof (r as KitResult).kit_url === 'string'
}

/** A Gmail compose window prefilled with the drafted outreach. The recipient is
 *  left blank unless the draft names one. `encodeURIComponent`, not
 *  URLSearchParams — the latter writes spaces as `+`, which Gmail shows as-is. */
export function gmailComposeUrl(r: {
  subject: string
  body: string
  to?: string | null
  authuser?: string | null
}): string {
  let url = 'https://mail.google.com/mail/?view=cm&fs=1'
  if (typeof r.authuser === 'string' && r.authuser !== '') url += `&authuser=${encodeUriSafe(r.authuser)}`
  if (typeof r.to === 'string' && r.to !== '') url += `&to=${encodeUriSafe(r.to)}`
  url += `&su=${encodeUriSafe(r.subject)}&body=${encodeUriSafe(r.body)}`
  return url
}

/** A lone UTF-16 surrogate (e.g. an emoji cut in half by a code-unit slice)
 *  becomes U+FFFD, so the string can be percent-encoded. */
export function toWellFormedString(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

/** encodeURIComponent never throws here: it is called during render, and a
 *  lone surrogate would make it throw URIError and take the page down. */
function encodeUriSafe(s: string): string {
  return encodeURIComponent(toWellFormedString(s))
}
