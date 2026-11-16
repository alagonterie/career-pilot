import { useEffect, useMemo, useRef, useState } from 'react'

import { InfoTip } from '~/components/InfoTip'
import {
  fetchTailoredRuns,
  isPromotedRefusal,
  NOT_INTERESTED_REASONS,
  postAdminLeads,
  postAppliedFromLead,
  postSweepNow,
  postUndoApplied,
  type AdminLead,
  type AdminLeadsSourcing,
  type AdminLeadsView,
  type AdminLeadsWrite,
  type AdminWriteResult,
  type BulkDeleteResult,
  type BulkSetStatusResult,
  type DuplicateApplication,
  type LeadSweepRun,
  type NotInterestedReason,
  type NotInterestedResult,
  type TailoredRun,
} from '~/lib/use-admin'
import { cn } from '~/lib/utils'

import { DataTable, type Column } from './DataTable'
import { TailorResume } from './TailorResume'

/**
 * The owner-only `/admin` Leads tab (§24.173) — the job_leads world-model the
 * orchestrator maintains (scrape-jobs writes it; the killer-match + close-detection
 * sweeps tend it). A read view (pool rollup + the leads + each lead's rules_score
 * REASONS breakdown — the *why* behind a score) plus a small, safe triage surface:
 * change status, archive (soft-close), and re-score against the current profile.
 * No content edits (source-of-record from the board) or manual creation — a
 * `manual`-source lead is synthesized host-side for an application that never had
 * a discovered one (§24.195), so the per-lead tools can still reach it.
 *
 * The table rides the shared DataTable (§24.174): the row cells are columns, the
 * per-lead score-reasons + triage controls are its `renderDetail` disclosure, and
 * the filter bar drives a `resetKey` so changing a filter jumps back to page 1.
 *
 * §24.187 adds the BATCH layer on top: an "older than N days" filter (the missing
 * primitive for "clear out everything from before I paused") plus a bulk bar that
 * archives or hard-deletes exactly the rows the filter is currently showing. The
 * batch acts on an explicit id list, never a filter spec the server re-derives —
 * WYSIWYG is the safety story for a destructive control, so the count in the
 * button is always the count in the table.
 *
 * §24.201 makes triage fast without the agent: a *Link* filter + per-row chip
 * (D1 — the one fact the owner triages on was buried in the detail), real row
 * selection (D2 — the batch acts on the ticked rows when any are ticked, else on
 * every shown row; the count is always the rows that will be acted on), j/k/o/a/
 * q/x keyboard triage (D3), "not interested" with a reason that teaches the
 * insert guard (D4), a sortable *Posted* column + a browser-kept "new since last
 * visit" marker (D5), and "I applied" (D8), which creates the application and
 * links THIS lead in one server action, with a short Undo window.
 */

// The statuses the owner can set (mirrors the server allow-list — 'applied' is
// agent-owned: it implies a promotion + an application_id the owner shouldn't fake).
const SETTABLE_STATUSES = ['new', 'reviewed', 'queued', 'rejected', 'archived'] as const

/** What a write refused because the lead already backs an application says. */
const PROMOTED_MESSAGE = 'This lead is already an application — change it on the Pipeline tab.'

type SortKey = 'rules_score' | 'llm_score' | 'first_seen_at' | 'last_seen_at' | 'source_posted_at'

// ── §24.201 D1: link kind, derived ────────────────────────────────────────────

/** The board sources whose apply link is direct by construction. */
export const BOARD_SOURCES: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby'])

/** Every lead source the host writes — the Source filter's options. */
export const LEAD_SOURCES = ['greenhouse', 'lever', 'ashby', 'google_jobs', 'manual'] as const

export type LinkKind = 'company' | 'ats' | 'aggregator' | 'unknown' | 'manual'
const LINK_FILTER_OPTIONS = ['all', 'company', 'ats', 'aggregator', 'unknown', 'manual'] as const

/** `apply_link_kind`, falling back to `source` when it is NULL: a manual lead
 *  reads *manual*, a board-sourced lead *direct ATS*, anything else *unknown*. */
export function linkKindOf(lead: Pick<AdminLead, 'apply_link_kind' | 'source'>): LinkKind {
  if (lead.apply_link_kind) return lead.apply_link_kind
  if (lead.source === 'manual') return 'manual'
  if (BOARD_SOURCES.has(lead.source)) return 'ats'
  return 'unknown'
}

const LINK_CHIP: Record<LinkKind, { label: string; tone: string; title: string }> = {
  ats: {
    label: 'direct ATS',
    tone: 'border-primary/40 text-primary',
    title: "Applies on the employer's own applicant-tracking board",
  },
  company: {
    label: 'company',
    tone: 'border-primary/40 text-primary',
    title: "Applies on the employer's careers site",
  },
  aggregator: {
    label: 'aggregator',
    tone: 'border-amber-400/50 text-amber-400',
    title: 'Only reached us via a reposter — the company name is unverified too',
  },
  unknown: { label: 'unknown', tone: 'border-border text-muted-foreground', title: 'No apply link was found' },
  manual: { label: 'manual', tone: 'border-border text-muted-foreground', title: 'Recorded by hand, not discovered' },
}

function LinkChip({ lead }: { lead: AdminLead }) {
  const kind = linkKindOf(lead)
  const chip = LINK_CHIP[kind]
  return (
    <span
      data-testid="leads-link-chip"
      data-kind={kind}
      title={chip.title}
      className={cn('inline-block whitespace-nowrap rounded border px-1.5 py-px font-mono text-[10px]', chip.tone)}
    >
      {chip.label}
    </span>
  )
}

// ── §24.201 D5: "new since last visit", kept in this browser ─────────────────

const LAST_VISIT_KEY = 'career-pilot.admin.leads.last-visit'

/** Every storage access is guarded: private windows, blocked site data and SSR
 *  all make `localStorage` throw or vanish, and the marker is a convenience. */
function readLastVisit(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_VISIT_KEY)
    if (!raw) return null
    const t = Number(raw)
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

function writeLastVisit(t: number): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(t))
  } catch {
    // storage unavailable — the marker simply never shows
  }
}

/** This browser session's baseline: the previous visit's timestamp as it stood
 *  when the session began ('' = there was none). The admin route mounts the
 *  panel only while its tab is active, so a "visit" has to be a browser
 *  session — otherwise every tab switch would count as a new visit and clear
 *  every marker. */
const SESSION_BASELINE_KEY = 'career-pilot.admin.leads.session-baseline'

/** In-memory stand-in for `sessionStorage` when it throws: the same page load
 *  is the same session. */
let memoryBaseline: { value: number | null } | null = null

function readSessionBaseline(): { value: number | null } | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_BASELINE_KEY)
    if (raw == null) return null
    const t = raw === '' ? null : Number(raw)
    return { value: t != null && Number.isFinite(t) ? t : null }
  } catch {
    return memoryBaseline
  }
}

function writeSessionBaseline(value: number | null): void {
  memoryBaseline = { value }
  try {
    window.sessionStorage.setItem(SESSION_BASELINE_KEY, value == null ? '' : String(value))
  } catch {
    // the in-memory copy carries this page load
  }
}

/** The "new since" baseline for this mount. The first mount of a browser
 *  session reads the stored last visit and advances it to now; every later
 *  mount in the same session reuses that first reading and writes nothing. */
export function sessionLastVisit(now: number = Date.now()): number | null {
  const existing = readSessionBaseline()
  if (existing) return existing.value
  const previous = readLastVisit()
  writeSessionBaseline(previous)
  writeLastVisit(now)
  return previous
}

/** Test hook: forget the in-memory session baseline. */
export function resetLeadsVisitSessionForTests(): void {
  memoryBaseline = null
}

function timeOf(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** Today as `YYYY-MM-DD` in the owner's local time (the date they applied). */
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A focused form control eats typed keys, so triage shortcuts stand down —
 *  except a checkbox/radio, which takes no text (ticking a row then pressing j
 *  must keep working). */
function isTypingTarget(el: EventTarget | Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el instanceof HTMLInputElement) return el.type !== 'checkbox' && el.type !== 'radio'
  return el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
}

/** A focused checkbox/radio. Navigation (j/k) still works from one, but the
 *  acting keys (o/a/q/x) stand down: right after ticking a row, the outlined
 *  row can be a different one than the row just interacted with. */
function isToggleControl(el: EventTarget | Element | null): boolean {
  return el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
}

function fmtAgeHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function ageHoursOf(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 3_600_000))
}

function fmtComp(lead: AdminLead): string {
  const { comp_min_usd: lo, comp_max_usd: hi, comp_period } = lead
  if (lo == null && hi == null) return '—'
  const k = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`)
  const range = lo != null && hi != null && lo !== hi ? `${k(lo)}–${k(hi)}` : k((hi ?? lo) as number)
  return comp_period && comp_period !== 'year' ? `${range}/${comp_period}` : range
}

function locationLabel(lead: AdminLead): string {
  if (lead.is_remote === 1) return lead.workplace_type ?? 'remote'
  if (lead.location_raw) return lead.location_raw
  return lead.workplace_type ?? '—'
}

function scoreTone(score: number | null): string {
  if (score == null) return 'text-muted-foreground'
  if (score >= 75) return 'text-primary'
  if (score >= 45) return 'text-foreground'
  return 'text-muted-foreground'
}

const STATUS_TONE: Record<string, string> = {
  new: 'text-accent-cool',
  reviewed: 'text-foreground',
  queued: 'text-primary',
  applied: 'text-primary',
  rejected: 'text-muted-foreground',
  archived: 'text-muted-foreground',
}

// ── the rules_score reasons breakdown (the *why*) ─────────────────────────────

interface ReasonComponent {
  key: string
  score: number | null
  detail: string
}

/** Flatten the rules_score_reasons JSON into ordered, human rows. Defensive — the
 * shape is the host's computeRulesScore output, but a malformed blob just yields []. */
function reasonRows(reasons: unknown): ReasonComponent[] {
  if (!reasons || typeof reasons !== 'object') return []
  const r = reasons as Record<string, Record<string, unknown>>
  const out: ReasonComponent[] = []
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

  if (r.neg_flag) {
    const hits = Array.isArray(r.neg_flag.hits) ? (r.neg_flag.hits as string[]).join(', ') : ''
    out.push({ key: 'negative filter', score: null, detail: `dropped — matched "${hits}"` })
    return out
  }
  if (r.keyword_match) {
    const m = r.keyword_match
    const matched = Array.isArray(m.matched) ? (m.matched as string[]).slice(0, 6).join(', ') : ''
    out.push({
      key: 'keyword',
      score: num(m.score),
      detail: `${num(m.title_hits) ?? 0} in title · ${num(m.desc_hits) ?? 0} in body${matched ? ` (${matched})` : ''}`,
    })
  }
  if (r.comp) {
    const c = r.comp
    const floor = num(c.floor)
    out.push({
      key: 'comp',
      score: num(c.score),
      detail: floor != null ? `vs $${Math.round(floor / 1000)}k floor` : 'no floor set',
    })
  }
  if (r.location) {
    const l = r.location
    const detail = l.off_location
      ? 'off-location (demoted)'
      : l.matched_city
        ? `matched ${String(l.matched_city)}`
        : l.is_remote === true
          ? `remote${l.remote_region ? ` · ${String(l.remote_region)}` : ''}`
          : 'neutral'
    out.push({ key: 'location', score: num(l.score), detail })
  }
  if (r.recency) {
    const rec = r.recency
    out.push({
      key: 'recency',
      score: num(rec.score),
      detail: rec.age_hours != null ? `${num(rec.age_hours)}h old` : '',
    })
  }
  if (r.source_mult) {
    const s = r.source_mult
    out.push({ key: 'source', score: null, detail: `${String(s.source)} ×${String(s.multiplier)}` })
  }
  return out
}

function ScoreReasons({ reasons }: { reasons: unknown }) {
  const rows = reasonRows(reasons)
  if (rows.length === 0) return <p className="text-[11px] text-muted-foreground">No score breakdown recorded.</p>
  return (
    <dl
      data-testid="leads-score-reasons"
      className="grid grid-cols-[auto_2.5rem_1fr] gap-x-3 gap-y-1 font-mono text-[11px]"
    >
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <dt className="uppercase tracking-wider text-muted-foreground">{r.key}</dt>
          <dd className={cn('text-right tabular-nums', (r.score ?? 0) < 0 ? 'text-destructive' : 'text-foreground')}>
            {r.score == null ? '—' : r.score > 0 ? `+${r.score}` : r.score}
          </dd>
          <dd className="text-muted-foreground">{r.detail}</dd>
        </div>
      ))}
    </dl>
  )
}

// ── the table columns + the expandable detail ─────────────────────────────────

function leadColumns(isNew: (lead: AdminLead) => boolean): Column<AdminLead>[] {
  return [
    {
      id: 'company',
      header: 'Company',
      cellClassName: 'text-foreground',
      cell: (lead) => (
        <span className="flex max-w-[14rem] items-center gap-1.5">
          {isNew(lead) ? (
            <span
              data-testid="leads-new-marker"
              aria-label="new since your last visit"
              title="New since your last visit"
              className="shrink-0 text-[8px] text-accent-cool"
            >
              ●
            </span>
          ) : null}
          <span className="truncate" title={lead.company}>
            {lead.company}
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cellClassName: 'text-muted-foreground',
      cell: (lead) => (
        <span className="block max-w-[16rem] truncate" title={lead.title}>
          {lead.title}
        </span>
      ),
    },
    { id: 'link', header: 'Link', cell: (lead) => <LinkChip lead={lead} /> },
    { id: 'location', header: 'Location', cellClassName: 'text-muted-foreground', cell: (lead) => locationLabel(lead) },
    {
      id: 'comp',
      header: 'Comp',
      align: 'right',
      cellClassName: 'font-mono tabular-nums text-muted-foreground',
      cell: (lead) => fmtComp(lead),
    },
    {
      id: 'score',
      header: 'Score',
      align: 'right',
      cell: (lead) => (
        <span className={cn('font-mono font-semibold tabular-nums', scoreTone(lead.rules_score))}>
          {lead.rules_score ?? '—'}
          {lead.llm_score != null ? (
            <span className="ml-1 text-[10px] text-muted-foreground">/{lead.llm_score}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (lead) => (
        <span className={cn('font-mono text-xs', STATUS_TONE[lead.status] ?? 'text-muted-foreground')}>
          {lead.status}
        </span>
      ),
    },
    {
      // §24.201 D5 — when the employer posted it (not when we first saw it).
      id: 'posted',
      header: 'Posted',
      cellClassName: 'font-mono text-xs text-muted-foreground',
      sort: (lead) => timeOf(lead.source_posted_at) ?? 0,
      cell: (lead) => (
        <span data-testid="leads-posted" title={lead.source_posted_at ?? 'no posting date'}>
          {fmtAgeHours(ageHoursOf(lead.source_posted_at))}
        </span>
      ),
    },
    {
      id: 'age',
      header: 'Seen',
      cellClassName: 'font-mono text-xs text-muted-foreground',
      cell: (lead) => fmtAgeHours(ageHoursOf(lead.first_seen_at)),
    },
  ]
}

/** An "I applied" this session recorded — the handle its Undo needs. */
interface AppliedEntry {
  application_id: string
  obfuscated_label: string
  undo_until: string
  /** The lead's own names — the panel-level Undo outlives the row (a filter can
   *  hide a just-applied lead), so it carries what it needs to label itself. */
  company: string
  title: string
}

interface LeadDetailProps {
  lead: AdminLead
  busy: string | null
  baseUrl: string
  onPost: (body: AdminLeadsWrite, busyKey: string) => void
  niOpen: boolean
  setNiOpen: (open: boolean) => void
  onNotInterested: (
    lead: AdminLead,
    reason: NotInterestedReason,
    excludeTitle: boolean,
    blockCompany: boolean | undefined,
  ) => void
  applied: AppliedEntry | undefined
  onApplied: (lead: AdminLead, entry: AppliedEntry) => void
  onAppliedRefused: (message: string) => void
}

/** The small uppercase label that heads each detail row. */
function RowLabel({ children }: { children: string }) {
  return (
    <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  )
}

function LeadDetail({
  lead,
  busy,
  baseUrl,
  onPost,
  niOpen,
  setNiOpen,
  onNotInterested,
  applied,
  onApplied,
  onAppliedRefused,
}: LeadDetailProps) {
  const settable = SETTABLE_STATUSES.includes(lead.status as (typeof SETTABLE_STATUSES)[number])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ScoreReasons reasons={lead.rules_score_reasons} />
      </div>
      {lead.snippet ? (
        <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground">{lead.snippet}…</p>
      ) : null}
      {/* Links — where the posting lives, and how direct that is. */}
      <div data-testid="leads-detail-links" className="flex flex-wrap items-center gap-3">
        {lead.source_url ? (
          <a
            href={lead.source_url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent-cool hover:underline"
          >
            source ↗
          </a>
        ) : null}
        {lead.apply_url ? (
          <a
            href={lead.apply_url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent-cool hover:underline"
          >
            apply ↗
          </a>
        ) : null}
        {/* §24.190: how direct that apply link is. An aggregator-only lead is
            flagged because it carries TWO problems at once — the application may
            be gated behind someone else's signup, AND the company name is
            unverified (Google's company_name is least reliable on a repost). */}
        {lead.apply_link_kind === 'aggregator' ? (
          <span
            data-testid="leads-link-aggregator"
            className="font-mono text-[11px] text-amber-400"
            title="No direct company or ATS link was available — this posting only reached us via a reposter, so the company name is unverified too."
          >
            ⚠ aggregator link · company unverified
          </span>
        ) : lead.apply_link_kind === 'company' || lead.apply_link_kind === 'ats' ? (
          <span data-testid="leads-link-direct" className="font-mono text-[11px] text-primary">
            ✓ direct {lead.apply_link_kind === 'ats' ? 'ATS' : 'company'} link
          </span>
        ) : null}
        {lead.killer_match_pushed_at ? <span className="font-mono text-[11px] text-primary">◆ pushed</span> : null}
        {lead.application_id ? (
          <span className="font-mono text-[11px] text-muted-foreground">promoted → application</span>
        ) : null}
        {lead.closed_at ? (
          <span className="font-mono text-[11px] text-muted-foreground">closed: {lead.closed_reason ?? '—'}</span>
        ) : null}
      </div>
      {/* Primary actions — things the owner DID or wants done about this lead. */}
      <div data-testid="leads-detail-actions" className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <RowLabel>act</RowLabel>
          <AppliedControl
            lead={lead}
            baseUrl={baseUrl}
            panelBusy={busy}
            applied={applied}
            onApplied={onApplied}
            onRefused={onAppliedRefused}
          />
          {/* ── SLOT: per-lead agent actions (§24.202) ──────────────────────
              "Research company" and "Draft outreach" buttons go here, after
              "I applied". Not built yet — keep this row's order when adding. */}
          {/* ── end slot ── */}
        </div>
      </div>
      {/* Triage — what the lead's state in the pool should be. */}
      <div data-testid="leads-detail-triage" className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <RowLabel>triage</RowLabel>
          <label
            htmlFor={`leads-status-${lead.id}`}
            className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            status
          </label>
          <select
            id={`leads-status-${lead.id}`}
            data-testid="leads-status-select"
            value={settable ? lead.status : ''}
            // A promoted lead is an application now: its status is the
            // Pipeline's to change (the server refuses it too).
            disabled={busy != null || lead.application_id != null}
            title={lead.application_id ? 'Already an application — change it on the Pipeline tab' : undefined}
            onChange={(e) => onPost({ action: 'set_status', id: lead.id, status: e.target.value }, `status-${lead.id}`)}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {!settable ? (
              <option value="" disabled>
                {lead.status}
              </option>
            ) : null}
            {SETTABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {!lead.application_id && !niOpen ? (
            <button
              type="button"
              data-testid="leads-ni-open"
              disabled={busy != null}
              onClick={() => setNiOpen(true)}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              title="Archive this lead and teach the scraper not to bring it back (x)"
            >
              Not interested…
            </button>
          ) : null}
          <button
            type="button"
            data-testid="leads-rescore"
            disabled={busy != null}
            onClick={() => onPost({ action: 'rescore', id: lead.id }, `rescore-${lead.id}`)}
            className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            title="Recompute this lead's rules_score against the current profile"
          >
            {busy === `rescore-${lead.id}` ? 'Re-scoring…' : 'Re-score'}
          </button>
        </div>
        {niOpen && !lead.application_id ? (
          <NotInterestedForm
            lead={lead}
            busy={busy}
            onCancel={() => setNiOpen(false)}
            onConfirm={(reason, excludeTitle, blockCompany) =>
              onNotInterested(lead, reason, excludeTitle, blockCompany)
            }
          />
        ) : null}
      </div>
      {/* §24.191 — tailor a résumé to this specific lead. Owner-only surface; a
          résumé naming a real employer never appears on a public route. */}
      <TailorResume leadId={lead.id} baseUrl={baseUrl} />
    </div>
  )
}

// ── §24.201 D4: "not interested" ──────────────────────────────────────────────

const REASON_HINT: Record<NotInterestedReason, string> = {
  role: 'wrong kind of role — this posting and near-identical re-posts stay out',
  level: 'wrong level — only this posting stays out (its sibling levels may be fine)',
  location: 'wrong location — only this posting stays out (other locations may be fine)',
  company: 'not this company — this posting and near-identical re-posts stay out',
  other: 'anything else — this posting and near-identical re-posts stay out',
}

/** Step two of "not interested": the reason, the opt-in title exclusion, the
 *  opt-in board block (board-sourced leads only — only they have a board on the
 *  watchlist to pause), and the confirm. Opening it was step one. */
function NotInterestedForm({
  lead,
  busy,
  onCancel,
  onConfirm,
}: {
  lead: AdminLead
  busy: string | null
  onCancel: () => void
  onConfirm: (reason: NotInterestedReason, excludeTitle: boolean, blockCompany: boolean | undefined) => void
}) {
  const [reason, setReason] = useState<NotInterestedReason>('role')
  const [excludeTitle, setExcludeTitle] = useState(false)
  const [blockCompany, setBlockCompany] = useState(false)
  const boardLead = BOARD_SOURCES.has(lead.source)
  return (
    <div
      data-testid="leads-ni-form"
      className="ml-14 flex max-w-2xl flex-col gap-2 rounded-md border border-border bg-background/60 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          reason
          <select
            data-testid="leads-ni-reason"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value as NotInterestedReason)}
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {NOT_INTERESTED_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            data-testid="leads-ni-exclude-title"
            checked={excludeTitle}
            onChange={(e) => setExcludeTitle(e.target.checked)}
          />
          exclude this title from future scrapes
        </label>
        {boardLead ? (
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              data-testid="leads-ni-block-company"
              checked={blockCompany}
              onChange={(e) => setBlockCompany(e.target.checked)}
            />
            block this company&apos;s board
          </label>
        ) : null}
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
        {REASON_HINT[reason]}
        {excludeTitle ? ` · every lead titled “${lead.title}” is refused from now on` : ''}
        {boardLead && blockCompany ? ` · ${lead.company}'s board stops being swept` : ''}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="leads-ni-confirm"
          disabled={busy != null}
          // Sent only where the box is offered: a search-sourced lead has no
          // board to pause, so its request leaves the field off entirely.
          onClick={() => onConfirm(reason, excludeTitle, boardLead ? blockCompany : undefined)}
          className="rounded-md border border-destructive px-2.5 py-1 font-mono text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          {busy === `ni-${lead.id}` ? 'Archiving…' : 'Confirm not interested'}
        </button>
        <button
          type="button"
          data-testid="leads-ni-cancel"
          onClick={onCancel}
          className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          cancel
        </button>
      </div>
    </div>
  )
}

// ── §24.201 D8: "I applied" ───────────────────────────────────────────────────

const MAX_APPLIED_NOTE = 1000

function fmtCountdown(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Undo, counting down to the server's `undo_until`. Past it, the button goes —
 *  the application is the Pipeline's to maintain from then on. */
function UndoCountdown({ until, busy, onUndo }: { until: string; busy: boolean; onUndo: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const end = timeOf(until)
  const left = end == null ? 0 : Math.max(0, Math.ceil((end - now) / 1000))
  if (left <= 0) {
    return (
      <span data-testid="leads-applied-undo-expired" className="font-mono text-[11px] text-muted-foreground">
        undo window passed
      </span>
    )
  }
  return (
    <button
      type="button"
      data-testid="leads-applied-undo"
      disabled={busy}
      onClick={onUndo}
      className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
    >
      {busy ? 'Undoing…' : `Undo (${fmtCountdown(left)})`}
    </button>
  )
}

function AppliedControl({
  lead,
  baseUrl,
  panelBusy,
  applied,
  onApplied,
  onRefused,
}: {
  lead: AdminLead
  baseUrl: string
  panelBusy: string | null
  applied: AppliedEntry | undefined
  onApplied: (lead: AdminLead, entry: AppliedEntry) => void
  onRefused: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(todayLocal)
  const [note, setNote] = useState('')
  // Only résumés tailored to THIS lead, and only ones that rendered — the server
  // refuses anything else with a 400 anyway.
  const [resumes, setResumes] = useState<TailoredRun[] | null>(null)
  const [resumeId, setResumeId] = useState('')
  const [duplicate, setDuplicate] = useState<DuplicateApplication | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    void fetchTailoredRuns(baseUrl, lead.id).then((runs) => {
      if (!live) return
      const ready = runs.filter((r) => r.status === 'ready' && r.has_resume)
      setResumes(ready)
      // Default to the newest ready résumé — the one most likely sent.
      setResumeId((cur) => cur || (ready[0]?.id ?? ''))
    })
    return () => {
      live = false
    }
  }, [open, baseUrl, lead.id])

  // The Undo itself lives in the panel's "just applied" strip, not here: the
  // refresh after recording can filter this row (and so this control) away.
  if (applied) {
    return (
      <span data-testid="leads-applied-state" className="font-mono text-[11px] text-primary">
        ✓ applied · {applied.obfuscated_label} · undo is above the table
      </span>
    )
  }
  // Already linked (by the agent or an earlier session) — the links row says so.
  if (lead.application_id) return null

  const submit = async (confirmDuplicate: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    const out = await postAppliedFromLead(baseUrl, {
      lead_id: lead.id,
      ...(date ? { applied_at: date } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(resumeId ? { tailored_resume_id: resumeId } : {}),
      ...(confirmDuplicate ? { confirm_duplicate: true } : {}),
    })
    setBusy(false)
    if (out.kind === 'ok') {
      setOpen(false)
      setDuplicate(null)
      onApplied(lead, {
        application_id: out.result.application_id,
        obfuscated_label: out.result.obfuscated_label,
        undo_until: out.result.undo_until,
        company: lead.company,
        title: lead.title,
      })
    } else if (out.kind === 'duplicate') {
      setDuplicate(out.duplicate_of)
    } else if (out.kind === 'already_linked') {
      setOpen(false)
      onRefused('This lead is already linked to an application.')
    } else if (out.kind === 'not_found') {
      setOpen(false)
      onRefused('That lead no longer exists.')
    } else {
      // 400 = a bad date, or a résumé that is not a ready one of this lead.
      setError(out.status === 400 ? `Refused: ${out.error}` : out.error)
    }
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      {!open ? (
        <button
          type="button"
          data-testid="leads-applied-open"
          disabled={panelBusy != null}
          onClick={() => setOpen(true)}
          className="self-start rounded-md border border-primary/60 px-2.5 py-1 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          title="Record that you applied — creates the application and links this lead"
        >
          I applied
        </button>
      ) : (
        <div
          data-testid="leads-applied-popover"
          className="flex max-w-xl flex-col gap-2 rounded-md border border-border bg-background/60 px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              applied
              <input
                type="date"
                data-testid="leads-applied-date"
                value={date}
                max={todayLocal()}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            {resumes && resumes.length > 0 ? (
              <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                résumé sent
                <select
                  data-testid="leads-applied-resume"
                  value={resumeId}
                  onChange={(e) => setResumeId(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">not recorded</option>
                  {resumes.map((r) => (
                    <option key={r.id} value={r.id}>
                      tailored {new Date(r.created_at).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <input
            data-testid="leads-applied-note"
            aria-label="Application note (optional)"
            value={note}
            maxLength={MAX_APPLIED_NOTE}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional) — e.g. referred by a friend"
            className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {duplicate ? (
            <div
              data-testid="leads-applied-duplicate"
              className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-amber-400"
            >
              <span>
                You already have an open application: {duplicate.company_name ?? '—'} · {duplicate.role_title ?? '—'} (
                {duplicate.status})
              </span>
              <button
                type="button"
                data-testid="leads-applied-create-anyway"
                disabled={busy}
                onClick={() => void submit(true)}
                className="rounded-md border border-amber-400/60 px-2.5 py-1 text-amber-400 transition-colors hover:bg-amber-400/10 disabled:opacity-50"
              >
                Create anyway
              </button>
            </div>
          ) : null}
          {error ? (
            <p data-testid="leads-applied-error" className="font-mono text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="leads-applied-confirm"
              disabled={busy || panelBusy != null}
              onClick={() => void submit(false)}
              className="rounded-md border border-primary/60 px-2.5 py-1 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record application'}
            </button>
            <button
              type="button"
              data-testid="leads-applied-cancel"
              onClick={() => {
                setOpen(false)
                setDuplicate(null)
                setError(null)
              }}
              className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── the panel ─────────────────────────────────────────────────────────────────

export function LeadsPanel({
  data,
  baseUrl,
  onSaved,
}: {
  data: AdminLeadsView | null
  baseUrl: string
  onSaved: () => void
}) {
  const [status, setStatus] = useState('all')
  const [source, setSource] = useState('all')
  const [linkKind, setLinkKind] = useState<string>('all')
  const [minScore, setMinScore] = useState('')
  const [minAgeDays, setMinAgeDays] = useState('')
  const [company, setCompany] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [sort, setSort] = useState<SortKey>('rules_score')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // The two-step confirm for the bulk actions — null, or which one is armed.
  const [arming, setArming] = useState<'archive' | 'delete' | null>(null)
  // §24.201 D2 — the ticked rows (lead ids). Empty = "act on all shown".
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // §24.201 D3 — keyboard triage: the focused row, the open disclosure, and the
  // table's display order (what j/k walk — it includes any header sort).
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [niOpenId, setNiOpenId] = useState<string | null>(null)
  // §24.201 D8 — "I applied"s recorded this session, keyed by lead id, so the
  // Undo survives the lead refresh that brings back its application_id.
  const [applied, setApplied] = useState<Record<string, AppliedEntry>>({})
  // §24.201 D5 — the previous visit's timestamp. A visit is a browser session:
  // the baseline is read once per session, so a tab switch (which remounts the
  // panel) keeps the markers instead of counting as a new visit.
  const [lastVisit, setLastVisit] = useState<number | null>(null)
  const visitStamped = useRef(false)
  useEffect(() => {
    if (visitStamped.current) return
    visitStamped.current = true
    setLastVisit(sessionLastVisit())
  }, [])

  // §24.201 D4 — the owner's title blocklist. A write's response carries the
  // fresh list; it stands in until the next poll brings the same list back.
  const [blocklistOverride, setBlocklistOverride] = useState<string[] | null>(null)
  useEffect(() => setBlocklistOverride(null), [data])
  const titleBlocklist = blocklistOverride ?? data?.titleBlocklist ?? []

  const post = async (body: AdminLeadsWrite, busyKey: string): Promise<AdminWriteResult> => {
    setBusy(busyKey)
    setError(null)
    const res: AdminWriteResult = await postAdminLeads(baseUrl, body)
    setBusy(null)
    if (isPromotedRefusal(res)) {
      // The lead became an application since this view was fetched — refresh
      // so the row shows it.
      setError(PROMOTED_MESSAGE)
      onSaved()
    } else if (!res.ok) setError(res.error ?? `write failed (${res.status})`)
    else onSaved()
    return res
  }

  const removeFromBlocklist = async (title: string): Promise<void> => {
    setNote(null)
    const res = await post({ action: 'title_blocklist_remove', title }, `blocklist-${title}`)
    if (!res.ok) return
    const list = res.data?.title_blocklist
    if (Array.isArray(list)) setBlocklistOverride(list.filter((t): t is string => typeof t === 'string'))
    setNote(`“${title}” is no longer excluded — leads with that title can come back.`)
  }

  const filtered = useMemo(() => {
    if (!data) return []
    const pool = includeClosed ? [...data.leads, ...data.closed] : data.leads
    const min = minScore === '' ? null : Number(minScore)
    const minAge = minAgeDays === '' ? null : Number(minAgeDays)
    const q = company.trim().toLowerCase()
    const rows = pool.filter(
      (l) =>
        (status === 'all' || l.status === status) &&
        (source === 'all' || l.source === source) &&
        (linkKind === 'all' || linkKindOf(l) === linkKind) &&
        (min == null || Number.isNaN(min) || (l.rules_score ?? 0) >= min) &&
        (minAge == null || Number.isNaN(minAge) || (ageHoursOf(l.first_seen_at) ?? 0) >= minAge * 24) &&
        (q === '' || l.company.toLowerCase().includes(q) || l.title.toLowerCase().includes(q)),
    )
    const val = (l: AdminLead): number =>
      sort === 'first_seen_at'
        ? new Date(l.first_seen_at).getTime()
        : sort === 'last_seen_at'
          ? new Date(l.last_seen_at).getTime()
          : sort === 'source_posted_at'
            ? (timeOf(l.source_posted_at) ?? 0)
            : sort === 'llm_score'
              ? (l.llm_score ?? -1)
              : (l.rules_score ?? -1)
    return [...rows].sort((a, b) => val(b) - val(a))
  }, [data, status, source, linkKind, minScore, minAgeDays, company, includeClosed, sort])

  const columns = useMemo(
    () =>
      leadColumns((l) => {
        if (lastVisit == null) return false
        const seen = timeOf(l.first_seen_at)
        return seen != null && seen > lastVisit
      }),
    [lastVisit],
  )

  // §24.187: the batch acts on exactly the rows it says it will. Disarm the
  // confirm whenever that set changes — a filter tweak OR a selection change —
  // so an armed "delete 40" can never fire against a different 40.
  const visibleIds = useMemo(() => filtered.map((l) => l.id), [filtered])
  const bulkSignature = visibleIds.join(',')
  // A ticked row the filters now hide is dropped from the selection: WYSIWYG
  // means a batch never touches a row the owner cannot see.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(visibleIds)
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [bulkSignature]) // keyed on the id signature, not the array identity
  const selectedVisible = useMemo(() => visibleIds.filter((id) => selected.has(id)), [visibleIds, selected])
  const bulkMode: 'selected' | 'shown' = selectedVisible.length > 0 ? 'selected' : 'shown'
  const targetIds = bulkMode === 'selected' ? selectedVisible : visibleIds
  const targetSignature = `${bulkMode}|${targetIds.join(',')}`
  useEffect(() => setArming(null), [targetSignature])

  const runBulk = async (kind: 'archive' | 'delete'): Promise<void> => {
    const ids = targetIds
    if (ids.length === 0) return
    setBusy(`bulk-${kind}`)
    setError(null)
    setNote(null)
    const res =
      kind === 'archive'
        ? await postAdminLeads(baseUrl, {
            action: 'bulk_set_status',
            ids,
            status: 'archived',
            reason: 'batch cleanup',
          })
        : await postAdminLeads(baseUrl, { action: 'bulk_delete', ids, confirm: true })
    setBusy(null)
    setArming(null)
    if (!res.ok) setError(res.error ?? `write failed (${res.status})`)
    else {
      setNote(
        kind === 'archive'
          ? bulkArchiveNote(ids.length, res.data as BulkSetStatusResult | undefined)
          : bulkDeleteNote(ids.length, res.data as BulkDeleteResult | undefined),
      )
      setSelected(new Set())
      onSaved()
    }
  }

  // §24.201 D4 — archive + a tombstone whose reach follows the reason.
  const notInterested = async (
    lead: AdminLead,
    reason: NotInterestedReason,
    excludeTitle: boolean,
    blockCompany: boolean | undefined,
  ): Promise<void> => {
    setBusy(`ni-${lead.id}`)
    setError(null)
    setNote(null)
    const res = await postAdminLeads(baseUrl, {
      action: 'not_interested',
      id: lead.id,
      reason,
      exclude_title: excludeTitle,
      ...(blockCompany === undefined ? {} : { block_company: blockCompany }),
    })
    setBusy(null)
    if (isPromotedRefusal(res)) {
      setNiOpenId(null)
      setError(PROMOTED_MESSAGE)
      onSaved()
      return
    }
    if (!res.ok) {
      setError(res.error ?? `write failed (${res.status})`)
      return
    }
    const d = (res.data ?? {}) as Partial<NotInterestedResult>
    if (Array.isArray(d.title_blocklist)) setBlocklistOverride(d.title_blocklist)
    setNiOpenId(null)
    setNote(notInterestedNote(lead, reason, d, blockCompany === true))
    onSaved()
  }

  // §24.201 D6 — "Sweep now". Its own in-flight flag, so a sweep request does
  // not lock the row controls (and vice versa).
  const [sweepBusy, setSweepBusy] = useState(false)
  const sweepNow = async (): Promise<void> => {
    setSweepBusy(true)
    setError(null)
    setNote(null)
    const out = await postSweepNow(baseUrl)
    setSweepBusy(false)
    if (out.kind === 'started') {
      setNote('Sweep started — its results appear here when it finishes.')
      onSaved()
    } else if (out.kind === 'already_running') {
      setError('A sweep is already running — its results appear here when it finishes.')
      onSaved()
    } else if (out.kind === 'halted') {
      setError('The system is halted, so no sweep was started. Resume it on the Overview tab first.')
    } else {
      setError(out.error)
    }
  }

  const onApplied = (lead: AdminLead, entry: AppliedEntry): void => {
    setApplied((prev) => ({ ...prev, [lead.id]: entry }))
    setError(null)
    setNote(`Recorded: applied to ${lead.company} (public card: ${entry.obfuscated_label}).`)
    onSaved()
  }

  const onAppliedRefused = (message: string): void => {
    setError(message)
    onSaved()
  }

  // Keyed by lead id, not by a row: the lead may no longer be in the view.
  const undoApplied = async (leadId: string, entry: AppliedEntry): Promise<void> => {
    setBusy(`undo-${leadId}`)
    setError(null)
    setNote(null)
    const out = await postUndoApplied(baseUrl, entry.application_id)
    setBusy(null)
    const drop = (): void =>
      setApplied((prev) => {
        const next = { ...prev }
        delete next[leadId]
        return next
      })
    if (out.kind === 'ok') {
      drop()
      setNote(`Undone — the application is gone and the lead is back to “${out.restored_status}”.`)
      onSaved()
    } else if (out.kind === 'window_passed') {
      drop()
      setError('The undo window has passed — the application stays; it is on the Pipeline tab now.')
    } else if (out.kind === 'referenced') {
      drop()
      setError(
        `Can’t undo: something else already refers to this application${out.detail ? ` (${out.detail})` : ''}. It stays on the Pipeline tab.`,
      )
    } else {
      setError(out.error)
    }
  }

  // ── §24.201 D3: keyboard triage ────────────────────────────────────────────
  // The table reports its display order; with no rows it renders nothing, so an
  // empty filter means an empty order (never a stale one).
  const navOrder = filtered.length === 0 ? [] : order
  const lastFocusIdx = useRef(0)
  // When the focused lead leaves the view (archived, filtered out), focus the
  // row now at its position — so `a`, `a`, `a` walks down the list.
  useEffect(() => {
    if (focusedKey == null) return
    const idx = navOrder.indexOf(focusedKey)
    if (idx >= 0) {
      lastFocusIdx.current = idx
      return
    }
    setFocusedKey(
      navOrder.length === 0 ? null : (navOrder[Math.min(lastFocusIdx.current, navOrder.length - 1)] ?? null),
    )
  }, [navOrder, focusedKey])

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    if (!['j', 'k', 'o', 'a', 'q', 'x'].includes(e.key)) return
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return
    const isNav = e.key === 'j' || e.key === 'k'
    if (!isNav && (isToggleControl(e.target) || isToggleControl(document.activeElement))) return
    if (navOrder.length === 0) return
    const idx = focusedKey == null ? -1 : navOrder.indexOf(focusedKey)
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault()
      const next = idx < 0 ? 0 : e.key === 'j' ? Math.min(idx + 1, navOrder.length - 1) : Math.max(idx - 1, 0)
      setFocusedKey(navOrder[next] ?? null)
      return
    }
    const lead = idx < 0 ? undefined : filtered.find((l) => l.id === focusedKey)
    if (!lead) return
    e.preventDefault()
    if (e.key === 'o') {
      const url = lead.apply_url ?? lead.source_url
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    } else if (e.key === 'a' || e.key === 'q') {
      if (busy != null) return
      // A promoted lead is an application now — a stray keystroke must not move
      // it back out of 'applied' (the same guard `x` has).
      if (lead.application_id) {
        setNote(`${lead.company} is already an application — change it on the Pipeline tab.`)
        return
      }
      const to = e.key === 'a' ? 'archived' : 'queued'
      void post({ action: 'set_status', id: lead.id, status: to }, `status-${lead.id}`)
    } else if (e.key === 'x') {
      if (lead.application_id) return
      setExpandedKey(lead.id)
      setNiOpenId(lead.id)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!data) return <p className="text-sm text-muted-foreground">No leads data yet.</p>
  const { rollup } = data
  const targetCount = targetIds.length

  return (
    <section data-testid="leads-panel" className="flex flex-col gap-4">
      {/* Rollup — the pool heartbeat */}
      <div
        data-testid="leads-rollup"
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-foreground">
            Lead pool
            {/* The status vocabulary is subtle (and mostly latent today) — one
                header-level explainer, the §24.60 "cast InfoTip" pattern. */}
            <InfoTip label="lead statuses">
              <span className="mb-1 block font-semibold normal-case tracking-normal text-foreground">
                Lead statuses
              </span>
              <ul className="flex flex-col gap-1 normal-case tracking-normal">
                <li>
                  <span className="font-mono text-foreground">new</span> — just discovered; the default (most leads stay
                  here)
                </li>
                <li>
                  <span className="font-mono text-foreground">reviewed</span> — triaged, parked for now
                </li>
                <li>
                  <span className="font-mono text-foreground">queued</span> — slated to act on (research / tailor /
                  outreach)
                </li>
                <li>
                  <span className="font-mono text-foreground">applied</span> — promoted to a real application
                </li>
                <li>
                  <span className="font-mono text-foreground">rejected</span> — actively passed on
                </li>
                <li>
                  <span className="font-mono text-foreground">archived</span> — removed from the active pool (a
                  soft-close)
                </li>
              </ul>
              <span className="mt-1.5 block normal-case tracking-normal">
                Today these mostly change by hand here — the agent has the tool but doesn&apos;t advance them on its own
                yet. The 14-day stale-sweep closes a lead without changing its status.
              </span>
            </InfoTip>
          </h2>
          <div className="flex flex-wrap items-start justify-end gap-2">
            <TitleBlocklist titles={titleBlocklist} busy={busy} onRemove={(t) => void removeFromBlocklist(t)} />
            {data.sourcing ? (
              <button
                type="button"
                data-testid="leads-sweep-now"
                disabled={sweepBusy || data.sourcing.sweepRunning}
                onClick={() => void sweepNow()}
                className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                title="Fetch every active employer board on the watchlist now, instead of waiting for the schedule"
              >
                {sweepBusy ? 'Starting…' : data.sourcing.sweepRunning ? 'Sweeping…' : 'Sweep now'}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="leads-rescore-all"
              disabled={busy != null || rollup.activeTotal === 0}
              onClick={() => post({ action: 'rescore_all' }, 'rescore_all')}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              title="Recompute every active lead's deterministic rules_score against the current profile"
            >
              {busy === 'rescore_all' ? 'Re-scoring…' : `Re-score all active (${rollup.activeTotal})`}
            </button>
          </div>
        </div>
        {data.sourcing ? <SourcingStrip sourcing={data.sourcing} /> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Active" value={rollup.activeTotal} />
          <Stat label="Newest" value={fmtAgeHours(rollup.newestAgeHours)} />
          <Stat label="Added 24h / 7d" value={`${rollup.added24h} / ${rollup.added7d}`} />
          <Stat label="LLM-scored" value={rollup.llmScored} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {Object.entries(rollup.byStatus).map(([s, n]) => (
            <Tag key={s} label={s} n={n} />
          ))}
          <span className="text-border">·</span>
          {Object.entries(rollup.bySource).map(([s, n]) => (
            <Tag key={s} label={s} n={n} />
          ))}
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          The roles the agent has discovered but not necessarily engaged — its running world-model. Built by{' '}
          <span className="font-mono">scrape-jobs</span>; {rollup.pushed24h} pushed as killer-matches in 24h;{' '}
          {rollup.closedTotal} closed (stale/archived).
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select label="Status" value={status} onChange={setStatus} options={['all', ...SETTABLE_STATUSES, 'applied']} />
        <Select label="Source" value={source} onChange={setSource} options={['all', ...LEAD_SOURCES]} />
        {/* §24.201 D1 — the fact the owner actually triages on. */}
        <Select label="Link" value={linkKind} onChange={setLinkKind} options={LINK_FILTER_OPTIONS} />
        <Select
          label="Sort"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          options={['rules_score', 'llm_score', 'source_posted_at', 'first_seen_at', 'last_seen_at']}
        />
        <input
          type="number"
          inputMode="numeric"
          placeholder="min score"
          value={minScore}
          data-testid="leads-min-score"
          onChange={(e) => setMinScore(e.target.value)}
          className="w-24 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {/* §24.187: the "clear out everything from before I paused" primitive —
            min age in days, over first_seen_at. */}
        <input
          type="number"
          inputMode="numeric"
          placeholder="older than (d)"
          value={minAgeDays}
          data-testid="leads-min-age"
          onChange={(e) => setMinAgeDays(e.target.value)}
          className="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <input
          type="search"
          placeholder="company / title"
          value={company}
          data-testid="leads-search"
          onChange={(e) => setCompany(e.target.value)}
          className="w-40 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            data-testid="leads-include-closed"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          include closed ({rollup.closedTotal})
        </label>
      </div>

      {/* Batch bar (§24.187 + §24.201 D2) — operates on the ticked rows when any
          are ticked, otherwise on every row the filters show; the count is
          always the number that will be acted on. Both actions are two-step in
          place: the first click arms, the second commits; any filter OR
          selection change disarms. */}
      {filtered.length > 0 ? (
        <div
          data-testid="leads-bulk-bar"
          data-mode={bulkMode}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            <span data-testid="leads-bulk-count" className="font-semibold tabular-nums text-foreground">
              {targetCount}
            </span>{' '}
            {bulkMode === 'selected' ? `selected of ${filtered.length} shown` : 'shown'}
          </span>
          {bulkMode === 'selected' ? (
            <button
              type="button"
              data-testid="leads-bulk-clear"
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              clear selection
            </button>
          ) : null}
          <span className="text-border">·</span>
          {arming === 'archive' ? (
            <>
              <button
                type="button"
                data-testid="leads-bulk-archive-confirm"
                disabled={busy != null}
                onClick={() => runBulk('archive')}
                className="rounded-md border border-accent-cool px-2.5 py-1 font-mono text-[11px] text-accent-cool transition-colors hover:bg-accent-cool/10 disabled:opacity-50"
              >
                {busy === 'bulk-archive' ? 'Archiving…' : `Confirm archive ${targetCount}?`}
              </button>
              <CancelButton onClick={() => setArming(null)} />
            </>
          ) : (
            <button
              type="button"
              data-testid="leads-bulk-archive"
              disabled={busy != null}
              onClick={() => setArming('archive')}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              title={`Soft-close every ${bulkMode === 'selected' ? 'selected' : 'shown'} lead — leaves the active pool, keeps its history`}
            >
              Archive {targetCount}
            </button>
          )}
          {arming === 'delete' ? (
            <>
              <button
                type="button"
                data-testid="leads-bulk-delete-confirm"
                disabled={busy != null}
                onClick={() => runBulk('delete')}
                className="rounded-md border border-destructive px-2.5 py-1 font-mono text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {busy === 'bulk-delete' ? 'Deleting…' : `Confirm delete ${targetCount}?`}
              </button>
              <CancelButton onClick={() => setArming(null)} />
              {/* Mirrors the host's bulk_delete exactly: it skips promoted and
                  email-linked leads only; a tailored résumé cascades with its lead. */}
              <span data-testid="leads-bulk-delete-warning" className="font-mono text-[11px] text-muted-foreground">
                permanent · promoted and email-linked leads are skipped; a tailored résumé is deleted with its lead
              </span>
            </>
          ) : (
            <button
              type="button"
              data-testid="leads-bulk-delete"
              disabled={busy != null}
              onClick={() => setArming('delete')}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
              title={`Permanently remove every ${bulkMode === 'selected' ? 'selected' : 'shown'} lead (promoted and email-linked leads are skipped; a tailored résumé goes with its lead)`}
            >
              Delete {targetCount}
            </button>
          )}
        </div>
      ) : null}

      {note ? (
        <p data-testid="leads-note" className="font-mono text-[11px] text-primary">
          {note}
        </p>
      ) : null}

      {error ? (
        <p data-testid="leads-error" className="font-mono text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      {/* §24.201 D8 — every "I applied" recorded this session, with its Undo.
          Panel-level on purpose: the refresh after recording flips the lead to
          'applied', which a Status (or other) filter can hide — the Undo must
          stay reachable for its whole window regardless of the view. */}
      {Object.keys(applied).length > 0 ? (
        <ul data-testid="leads-applied-recent" className="flex flex-col gap-1.5">
          {Object.entries(applied).map(([leadId, entry]) => (
            <li
              key={leadId}
              data-testid="leads-applied-entry"
              className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 px-3 py-1.5"
            >
              <span className="font-mono text-[11px] text-primary">
                ✓ applied · {entry.company} — {entry.title} · public card: {entry.obfuscated_label}
              </span>
              <UndoCountdown
                until={entry.undo_until}
                busy={busy === `undo-${leadId}`}
                onUndo={() => void undoApplied(leadId, entry)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {filtered.length > 0 ? (
        <p data-testid="leads-kbd-hint" className="hidden font-mono text-[10px] text-muted-foreground sm:block">
          keys: <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>o</Kbd> open apply link · <Kbd>a</Kbd> archive · <Kbd>q</Kbd>{' '}
          queue · <Kbd>x</Kbd> not interested
        </p>
      ) : null}

      {/* Table — the shared DataTable; the score-reasons + triage controls are the
          expandable detail; the filter signature resets pagination to page 1. */}
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(lead) => lead.id}
        rowTestId="leads-row"
        detailTestId="leads-detail"
        selection={{
          selected,
          onChange: setSelected,
          rowLabel: (lead) => `Select ${lead.company} — ${lead.title}`,
        }}
        focusedKey={focusedKey}
        onRowFocus={(key) => setFocusedKey(key)}
        expandedKey={expandedKey}
        onExpandedChange={(key) => {
          setExpandedKey(key)
          if (key !== niOpenId) setNiOpenId(null)
        }}
        onOrderChange={setOrder}
        renderDetail={(lead) => (
          <LeadDetail
            lead={lead}
            busy={busy}
            baseUrl={baseUrl}
            onPost={post}
            niOpen={niOpenId === lead.id}
            setNiOpen={(open) => setNiOpenId(open ? lead.id : null)}
            onNotInterested={(l, reason, excludeTitle, blockCompany) =>
              void notInterested(l, reason, excludeTitle, blockCompany)
            }
            applied={applied[lead.id]}
            onApplied={onApplied}
            onAppliedRefused={onAppliedRefused}
          />
        )}
        resetKey={`${status}|${source}|${linkKind}|${minScore}|${minAgeDays}|${company}|${includeClosed}|${sort}`}
        minWidthClass="min-w-[58rem]"
        empty={
          <p data-testid="leads-empty" className="text-sm text-muted-foreground">
            No leads match this filter.
          </p>
        }
      />
    </section>
  )
}

/** The result line for a bulk delete. Reports the server's own counts and its
 *  skip reasons (§24.200 D3) when it sends them; an older host that does not
 *  falls back to the honest "up to N". */
export function bulkDeleteNote(requested: number, d: BulkDeleteResult | undefined): string {
  const plural = (n: number) => `${n} lead${n === 1 ? '' : 's'}`
  if (typeof d?.deleted !== 'number') return `Deleted up to ${plural(requested)} (promoted leads skipped).`
  const reasons = d.skipped_by_reason ?? {}
  const parts = [
    reasons.promoted ? `${reasons.promoted} promoted to an application` : null,
    reasons.email_linked ? `${reasons.email_linked} linked to an email` : null,
  ].filter((p): p is string => p != null)
  const skipped = d.skipped ?? 0
  const skipText = skipped > 0 ? ` Skipped ${skipped}${parts.length ? `: ${parts.join(', ')}` : ''}.` : ''
  return `Deleted ${plural(d.deleted)}.${skipText}`
}

/** The result line for a bulk archive. Promoted leads are skipped by the host
 *  (an application's status is the Pipeline's to change); an older host that
 *  sends no counts falls back to the requested number. */
export function bulkArchiveNote(requested: number, d: BulkSetStatusResult | undefined): string {
  const plural = (n: number) => `${n} lead${n === 1 ? '' : 's'}`
  const archived = typeof d?.updated === 'number' ? d.updated : requested
  const skipped = d?.skipped ?? 0
  const promoted = d?.skipped_by_reason?.promoted ?? 0
  const skipText =
    skipped > 0 ? ` Skipped ${skipped}${promoted ? `: ${promoted} promoted to an application` : ''}.` : ''
  return `Archived ${plural(archived)}.${skipText}`
}

/** The result line for "not interested": the tombstone's reach, then each
 *  opt-in consequence the server confirmed. `blockAsked` is whether the owner
 *  ticked "block this company's board" — only then is `company_blocked` read. */
export function notInterestedNote(
  lead: Pick<AdminLead, 'company' | 'title'>,
  reason: NotInterestedReason,
  d: Partial<NotInterestedResult>,
  blockAsked: boolean,
): string {
  const parts = [
    d.tombstone_match === 'fingerprint'
      ? 'this posting and near-identical re-posts from this company will not come back'
      : 'this posting will not come back',
  ]
  if (d.title_blocklisted) parts.push(`the title “${lead.title}” is now excluded`)
  if (blockAsked) {
    parts.push(
      d.company_blocked === true
        ? `${lead.company}'s board paused`
        : d.company_blocked === false
          ? `no board on the watchlist for ${lead.company}`
          : 'the board block was not confirmed',
    )
  }
  return `Not interested (${reason}): archived ${lead.company} — ${parts.join('; ')}.`
}

// ── §24.201 D6: the sourcing strip ────────────────────────────────────────────

/** "3h ago", "just now", or "—". */
function ago(iso: string | null): string {
  const h = ageHoursOf(iso)
  if (h == null) return '—'
  return h < 1 ? 'just now' : `${fmtAgeHours(h)} ago`
}

/** `{a: 3, b: 1}` → "a 3 · b 1", largest first, zero counts dropped; '' when empty. */
function countsLine(counts: Record<string, number> | null | undefined): string {
  return Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')
}

/** The last sweep in one line: when, what changed in the pool, board health. */
export function sweepSummary(run: LeadSweepRun): string {
  const when = run.finished_at ?? run.started_at
  const head = `Last sweep ${ago(when)}${run.trigger === 'manual' ? ' (manual)' : ''}${run.ok ? '' : ' · failed'}`
  return (
    `${head} · ${run.new} new · ${run.closed} closed · ${run.reopened} reopened · ` +
    `boards ${run.boards_ok} ok / ${run.boards_failed} failed`
  )
}

/** The search quota as "used / quota this period · today used / cap". */
export function quotaLine(q: AdminLeadsSourcing['searchQuota']): string {
  return `${q.used_period} / ${q.monthly_quota} this period · today ${q.used_today} / ${q.daily_cap}`
}

/** §24.201 D6 — the direct-board sweep and the search supplement, compactly:
 *  the last sweep's summary (expandable to its rejections and failing boards),
 *  the last search's refusals by reposting site, and the search quota. */
function SourcingStrip({ sourcing }: { sourcing: AdminLeadsSourcing }) {
  const [open, setOpen] = useState(false)
  const run = sourcing.lastSweep
  const rejected = countsLine(run?.rejected)
  const failing = run?.failing_boards ?? []
  const bySite = countsLine(sourcing.lastSearch?.rejected_by_site)
  return (
    <div
      data-testid="leads-sourcing"
      className="flex flex-col gap-1 border-t border-border/60 pt-2 font-mono text-[11px] text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[10px] uppercase tracking-widest text-foreground">Sourcing</span>
        {sourcing.sweepRunning ? (
          <span data-testid="leads-sweep-running" className="text-accent-cool">
            sweep running…
          </span>
        ) : null}
        <span data-testid="leads-sweep-summary" className={cn(run && !run.ok && 'text-amber-400')}>
          {run ? sweepSummary(run) : 'No sweep has run yet'}
        </span>
        {run ? (
          <button
            type="button"
            data-testid="leads-sweep-detail-toggle"
            aria-expanded={open}
            aria-controls="leads-sweep-detail"
            onClick={() => setOpen((o) => !o)}
            className="rounded-md px-1.5 py-px transition-colors hover:text-foreground"
          >
            details {open ? '▾' : '▸'}
          </button>
        ) : null}
      </div>
      {run && open ? (
        <div id="leads-sweep-detail" data-testid="leads-sweep-detail" className="ml-2 flex flex-col gap-0.5">
          <span>refreshed {run.refreshed} still-open leads</span>
          <span data-testid="leads-sweep-rejected">rejected: {rejected || 'none'}</span>
          {failing.length > 0 ? (
            <ul data-testid="leads-sweep-failing" aria-label="Failing boards" className="flex flex-col gap-0.5">
              {failing.map((b) => (
                <li key={`${b.ats}:${b.company}`} data-testid="leads-sweep-failing-board" className="text-amber-400">
                  {b.company} ({b.ats}) — {b.error}
                </li>
              ))}
            </ul>
          ) : (
            <span>no failing boards</span>
          )}
        </div>
      ) : null}
      {sourcing.lastSearch ? (
        <span data-testid="leads-search-summary">
          Last search {ago(sourcing.lastSearch.at)} · rejected by site: {bySite || 'none'}
        </span>
      ) : null}
      <span data-testid="leads-search-quota" title="Search pages spent — the search index is a capped supplement">
        Search quota {quotaLine(sourcing.searchQuota)}
      </span>
    </div>
  )
}

/** §24.201 D4 — the owner's excluded titles, in the Leads header. Collapsed by
 *  default (it only grows); each entry has its own remove — the one-click undo
 *  of "exclude this title". Hidden when empty. */
function TitleBlocklist({
  titles,
  busy,
  onRemove,
}: {
  titles: string[]
  busy: string | null
  onRemove: (title: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (titles.length === 0) return null
  return (
    <div data-testid="leads-blocklist" className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        data-testid="leads-blocklist-toggle"
        aria-expanded={open}
        aria-controls="leads-blocklist-entries"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        title="Titles refused from every future scrape"
      >
        {titles.length} excluded title{titles.length === 1 ? '' : 's'} {open ? '▾' : '▸'}
      </button>
      {open ? (
        <ul id="leads-blocklist-entries" aria-label="Excluded titles" className="flex flex-col items-end gap-1">
          {titles.map((t) => (
            <li
              key={t}
              data-testid="leads-blocklist-entry"
              className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"
            >
              <span className="max-w-[18rem] truncate text-foreground" title={t}>
                {t}
              </span>
              <button
                type="button"
                data-testid="leads-blocklist-remove"
                aria-label={`Stop excluding “${t}”`}
                disabled={busy != null}
                onClick={() => onRemove(t)}
                className="rounded-md border border-border px-1.5 py-px transition-colors hover:text-foreground disabled:opacity-50"
              >
                {busy === `blocklist-${t}` ? '…' : 'remove'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-border px-1 text-foreground">{children}</kbd>
}

/** The disarm control beside an armed bulk confirm. */
function CancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="leads-bulk-cancel"
      onClick={onClick}
      className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      cancel
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-background px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function Tag({ label, n }: { label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      {label}
      <span className="font-semibold tabular-nums text-foreground">{n}</span>
    </span>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: readonly string[]
}) {
  return (
    <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      {label}
      <select
        value={value}
        data-testid={`leads-filter-${label.toLowerCase()}`}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}
