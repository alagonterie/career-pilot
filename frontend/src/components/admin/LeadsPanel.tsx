import { useEffect, useMemo, useState } from 'react'

import { InfoTip } from '~/components/InfoTip'
import {
  postAdminLeads,
  type AdminLead,
  type AdminLeadsView,
  type AdminLeadsWrite,
  type AdminWriteResult,
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
 * No content edits (source-of-record from the board) or manual creation.
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
 */

// The statuses the owner can set (mirrors the server allow-list — 'applied' is
// agent-owned: it implies a promotion + an application_id the owner shouldn't fake).
const SETTABLE_STATUSES = ['new', 'reviewed', 'queued', 'rejected', 'archived'] as const

type SortKey = 'rules_score' | 'llm_score' | 'first_seen_at' | 'last_seen_at'

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

const LEAD_COLUMNS: Column<AdminLead>[] = [
  {
    id: 'company',
    header: 'Company',
    cellClassName: 'text-foreground',
    cell: (lead) => (
      <span className="block max-w-[14rem] truncate" title={lead.company}>
        {lead.company}
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
    id: 'age',
    header: 'Age',
    cellClassName: 'font-mono text-xs text-muted-foreground',
    cell: (lead) => fmtAgeHours(ageHoursOf(lead.first_seen_at)),
  },
]

function LeadDetail({
  lead,
  busy,
  baseUrl,
  onPost,
}: {
  lead: AdminLead
  busy: string | null
  baseUrl: string
  onPost: (body: AdminLeadsWrite, busyKey: string) => void
}) {
  const settable = SETTABLE_STATUSES.includes(lead.status as (typeof SETTABLE_STATUSES)[number])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ScoreReasons reasons={lead.rules_score_reasons} />
      </div>
      {lead.snippet ? (
        <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground">{lead.snippet}…</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={lead.source_url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-accent-cool hover:underline"
        >
          source ↗
        </a>
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
      {/* Triage actions */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">status</label>
        <select
          data-testid="leads-status-select"
          value={settable ? lead.status : ''}
          disabled={busy != null}
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
      {/* §24.191 — tailor a résumé to this specific lead. Owner-only surface; a
          résumé naming a real employer never appears on a public route. */}
      <TailorResume leadId={lead.id} baseUrl={baseUrl} />
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

  const post = async (body: AdminLeadsWrite, busyKey: string): Promise<void> => {
    setBusy(busyKey)
    setError(null)
    const res: AdminWriteResult = await postAdminLeads(baseUrl, body)
    setBusy(null)
    if (!res.ok) setError(res.error ?? `write failed (${res.status})`)
    else onSaved()
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
        (min == null || Number.isNaN(min) || (l.rules_score ?? 0) >= min) &&
        (minAge == null || Number.isNaN(minAge) || (ageHoursOf(l.first_seen_at) ?? 0) >= minAge * 24) &&
        (q === '' || l.company.toLowerCase().includes(q) || l.title.toLowerCase().includes(q)),
    )
    const val = (l: AdminLead): number =>
      sort === 'first_seen_at'
        ? new Date(l.first_seen_at).getTime()
        : sort === 'last_seen_at'
          ? new Date(l.last_seen_at).getTime()
          : sort === 'llm_score'
            ? (l.llm_score ?? -1)
            : (l.rules_score ?? -1)
    return [...rows].sort((a, b) => val(b) - val(a))
  }, [data, status, source, minScore, minAgeDays, company, includeClosed, sort])

  // §24.187: the batch acts on exactly these rows. Disarm the confirm whenever
  // the visible set changes, so an armed "delete 40" can never fire against a
  // different 40 after a filter tweak.
  const visibleIds = useMemo(() => filtered.map((l) => l.id), [filtered])
  const bulkSignature = visibleIds.join(',')
  useEffect(() => setArming(null), [bulkSignature])

  const runBulk = async (kind: 'archive' | 'delete'): Promise<void> => {
    const ids = visibleIds
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
          ? `Archived ${ids.length} lead${ids.length === 1 ? '' : 's'}.`
          : `Deleted up to ${ids.length} lead${ids.length === 1 ? '' : 's'} (promoted leads skipped).`,
      )
      onSaved()
    }
  }

  if (!data) return <p className="text-sm text-muted-foreground">No leads data yet.</p>
  const { rollup } = data

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
        <Select
          label="Source"
          value={source}
          onChange={setSource}
          options={['all', 'greenhouse', 'lever', 'google_jobs']}
        />
        <Select
          label="Sort"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          options={['rules_score', 'llm_score', 'first_seen_at', 'last_seen_at']}
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

      {/* Batch bar (§24.187) — operates on exactly the rows the filters above
          select. Both actions are two-step in place: the first click arms, the
          second commits; any filter change disarms. */}
      {filtered.length > 0 ? (
        <div
          data-testid="leads-bulk-bar"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            <span data-testid="leads-bulk-count" className="font-semibold tabular-nums text-foreground">
              {filtered.length}
            </span>{' '}
            shown
          </span>
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
                {busy === 'bulk-archive' ? 'Archiving…' : `Confirm archive ${filtered.length}?`}
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
              title="Soft-close every shown lead — leaves the active pool, keeps its history"
            >
              Archive {filtered.length}
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
                {busy === 'bulk-delete' ? 'Deleting…' : `Confirm delete ${filtered.length}?`}
              </button>
              <CancelButton onClick={() => setArming(null)} />
              <span className="font-mono text-[11px] text-muted-foreground">
                permanent · promoted leads are skipped
              </span>
            </>
          ) : (
            <button
              type="button"
              data-testid="leads-bulk-delete"
              disabled={busy != null}
              onClick={() => setArming('delete')}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
              title="Permanently remove every shown lead (leads promoted to an application are skipped)"
            >
              Delete {filtered.length}
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

      {/* Table — the shared DataTable; the score-reasons + triage controls are the
          expandable detail; the filter signature resets pagination to page 1. */}
      <DataTable
        columns={LEAD_COLUMNS}
        rows={filtered}
        rowKey={(lead) => lead.id}
        rowTestId="leads-row"
        detailTestId="leads-detail"
        renderDetail={(lead) => <LeadDetail lead={lead} busy={busy} baseUrl={baseUrl} onPost={post} />}
        resetKey={`${status}|${source}|${minScore}|${minAgeDays}|${company}|${includeClosed}|${sort}`}
        minWidthClass="min-w-[48rem]"
        empty={
          <p data-testid="leads-empty" className="text-sm text-muted-foreground">
            No leads match this filter.
          </p>
        }
      />
    </section>
  )
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
