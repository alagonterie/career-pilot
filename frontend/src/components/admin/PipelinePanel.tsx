import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { fmtTs } from '~/lib/admin-format'
import {
  tailoredPdfUrl,
  type AdminPipeline,
  type AdminPipelineRow,
  type PipelineAttentionItem,
  type ScribePriority,
} from '~/lib/use-admin'
import { cn } from '~/lib/utils'

import { DataTable, type Column } from './DataTable'

/**
 * The `/admin` Pipeline tab (§24.138; migrated onto the shared DataTable §24.174).
 * The OWNER view of the application pipeline — real company names (the public
 * surface is anonymized to obfuscated_label). A stage-count strip + the table.
 *
 * §24.204: still strictly READ-ONLY — stage changes stay the pipeline scribe's and
 * the agent's, so nothing here writes. It catches up with what the public page
 * shows and surfaces what the scribe concluded: an expandable row detail (win
 * rationale, stage timeline, the scribe's narrative + suggestions, learnings,
 * links out), a needs-attention chip with sort + filter, a days-in-stage column
 * tinted past the scribe's ghosting thresholds, a last-email column, and
 * clickable stage chips as a filter. Every one of those fields is optional: an
 * older host omits them and the tab renders its original five columns.
 */

const PRIORITY_RANK: Record<ScribePriority, number> = { same_day: 3, action_owed: 2, fyi: 1 }

const PRIORITY_CHIP: Record<ScribePriority, { label: string; tone: string }> = {
  same_day: { label: 'same day', tone: 'border-destructive/60 text-destructive' },
  action_owed: { label: 'action owed', tone: 'border-amber-400/50 text-amber-400' },
  fyi: { label: 'fyi', tone: 'border-border text-muted-foreground' },
}

const ATTENTION_FILTERS = ['all', 'any', 'same_day', 'action_owed', 'fyi'] as const
type AttentionFilter = (typeof ATTENTION_FILTERS)[number]
const ATTENTION_FILTER_LABEL: Record<AttentionFilter, string> = {
  all: 'All rows',
  any: 'Needs attention',
  same_day: 'Same day',
  action_owed: 'Action owed',
  fyi: 'FYI',
}

const linkClass = 'font-mono text-[11px] text-accent-cool hover:underline'

const tsOf = (iso: string | null | undefined): number => {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** Past the threshold — the host's flag, or derived when it sent only the numbers. */
export function isGhosting(r: AdminPipelineRow): boolean {
  if (typeof r.ghosting === 'boolean') return r.ghosting
  return r.days_in_stage != null && r.ghosting_threshold_days != null && r.days_in_stage >= r.ghosting_threshold_days
}

function attentionTitle(item: PipelineAttentionItem): string {
  return item.hint ? `${item.reason} — ${item.hint}` : item.reason
}

function AttentionChip({ row }: { row: AdminPipelineRow }) {
  const top = row.attention_top ?? row.attention?.[0]?.priority ?? null
  if (!top) return <span className="text-muted-foreground">—</span>
  const chip = PRIORITY_CHIP[top]
  const items = row.attention ?? []
  const first = items[0]
  return (
    <span
      data-testid="pipeline-attention-chip"
      data-priority={top}
      title={first ? attentionTitle(first) : undefined}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px font-mono text-[10px]',
        chip.tone,
      )}
    >
      {chip.label}
      {items.length > 1 ? <span className="tabular-nums">+{items.length - 1}</span> : null}
    </span>
  )
}

const BASE_COLUMNS: Column<AdminPipelineRow>[] = [
  {
    id: 'company',
    header: 'Company',
    cellClassName: 'text-foreground',
    cell: (r) => (
      <span className="flex max-w-[16rem] items-baseline gap-2">
        <span className="truncate" title={r.company_name ?? undefined}>
          {r.company_name ?? '—'}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.obfuscated_label ?? ''}</span>
      </span>
    ),
  },
  {
    id: 'role',
    header: 'Role',
    cellClassName: 'text-muted-foreground',
    cell: (r) => (
      <span className="block max-w-[14rem] truncate" title={r.role_title ?? undefined}>
        {r.role_title ?? '—'}
      </span>
    ),
  },
  { id: 'stage', header: 'Stage', cellClassName: 'text-foreground', cell: (r) => r.stage },
]

const ATTENTION_COLUMN: Column<AdminPipelineRow> = {
  id: 'attention',
  header: 'Attention',
  sort: (r) => {
    const top = r.attention_top ?? r.attention?.[0]?.priority ?? null
    return top ? PRIORITY_RANK[top] : 0
  },
  cell: (r) => <AttentionChip row={r} />,
}

const DAYS_COLUMN: Column<AdminPipelineRow> = {
  id: 'days',
  header: 'In stage',
  align: 'right',
  cellClassName: 'font-mono tabular-nums',
  sort: (r) => r.days_in_stage ?? -1,
  cell: (r) => {
    if (r.days_in_stage == null) return <span className="text-muted-foreground">—</span>
    const ghosting = isGhosting(r)
    return (
      <span
        data-testid="pipeline-days"
        data-ghosting={ghosting ? 'true' : 'false'}
        title={
          ghosting && r.ghosting_threshold_days != null
            ? `Past the ${r.ghosting_threshold_days}-day ghosting threshold for this stage`
            : undefined
        }
        className={cn(ghosting ? 'font-semibold text-amber-400' : 'text-foreground')}
      >
        {r.days_in_stage}d
      </span>
    )
  },
}

const WIN_COLUMN: Column<AdminPipelineRow> = {
  id: 'win',
  header: 'Win',
  align: 'right',
  cellClassName: 'font-mono tabular-nums text-foreground',
  sort: (r) => r.win_confidence ?? -1,
  cell: (r) => (r.win_confidence != null ? `${r.win_confidence}%` : '—'),
}

const LAST_EMAIL_COLUMN: Column<AdminPipelineRow> = {
  id: 'email',
  header: 'Last email',
  cellClassName: 'text-xs text-muted-foreground',
  sort: (r) => tsOf(r.last_email?.at),
  cell: (r) =>
    r.last_email ? (
      <span data-testid="pipeline-last-email" className="flex max-w-[14rem] flex-col">
        <span className="font-mono">{fmtTs(r.last_email.at)}</span>
        <span className="truncate" title={r.last_email.subject ?? undefined}>
          {r.last_email.subject ?? r.last_email.classification}
        </span>
      </span>
    ) : (
      '—'
    ),
}

const LAST_ACTIVITY_COLUMN: Column<AdminPipelineRow> = {
  id: 'last',
  header: 'Last activity',
  cellClassName: 'font-mono text-xs text-muted-foreground',
  sort: (r) => tsOf(r.last_activity_at),
  cell: (r) => fmtTs(r.last_activity_at),
}

/** Which §24.204 fields this host sends (each one independently). */
function capabilities(rows: AdminPipelineRow[]) {
  const has = (k: keyof AdminPipelineRow) => rows.some((r) => r[k] !== undefined)
  return {
    attention: has('attention_top') || has('attention'),
    days: has('days_in_stage'),
    email: has('last_email'),
    detail: [
      'win_confidence_rationale',
      'timeline',
      'narrative',
      'suggestions',
      'attention',
      'learnings',
      'kits',
      'tailored_resumes',
      'posting_url',
      'active_kit_url',
      'last_email',
    ].some((k) => has(k as keyof AdminPipelineRow)),
  }
}

export function PipelinePanel({
  rows,
  stageCounts,
  scribe,
  baseUrl = '',
}: {
  rows: AdminPipelineRow[]
  stageCounts: Record<string, number>
  scribe?: AdminPipeline['scribe']
  /** The API origin, for the owner-gated tailored-résumé PDF links. */
  baseUrl?: string
}) {
  const [stageFilter, setStageFilter] = useState<string | null>(null)
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>('all')
  const caps = useMemo(() => capabilities(rows), [rows])
  // A poll can empty the selected stage, and its chip (the only control that
  // clears it) goes with it — a stage that is no longer counted stops filtering.
  const activeStage = stageFilter != null && Object.hasOwn(stageCounts, stageFilter) ? stageFilter : null
  useEffect(() => {
    if (stageFilter != null && activeStage == null) setStageFilter(null)
  }, [stageFilter, activeStage])

  const columns = useMemo(() => {
    const cols = [...BASE_COLUMNS]
    if (caps.attention) cols.push(ATTENTION_COLUMN)
    if (caps.days) cols.push(DAYS_COLUMN)
    cols.push(WIN_COLUMN)
    if (caps.email) cols.push(LAST_EMAIL_COLUMN)
    cols.push(LAST_ACTIVITY_COLUMN)
    return cols
  }, [caps])

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (activeStage != null && r.stage !== activeStage) return false
        if (attentionFilter === 'all') return true
        const top = r.attention_top ?? r.attention?.[0]?.priority ?? null
        if (attentionFilter === 'any') return top != null
        return (r.attention ?? []).some((a) => a.priority === attentionFilter) || top === attentionFilter
      }),
    [rows, activeStage, attentionFilter],
  )

  const attentionCount = useMemo(
    () => rows.filter((r) => (r.attention_top ?? r.attention?.[0]?.priority ?? null) != null).length,
    [rows],
  )
  const unlinked = scribe?.attention_unlinked ?? []

  return (
    <section data-testid="pipeline-panel" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(stageCounts).map(([stage, n]) => {
          const active = activeStage === stage
          return (
            <button
              key={stage}
              type="button"
              data-testid={`pipeline-stage-chip-${stage}`}
              aria-pressed={active}
              title={active ? 'Show every stage' : `Show only ${stage}`}
              onClick={() => setStageFilter(active ? null : stage)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
                active
                  ? 'border-accent-cool text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {stage}
              <span className="font-semibold tabular-nums text-foreground">{n}</span>
            </button>
          )
        })}
        {caps.attention ? (
          <label className="ml-auto inline-flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            Attention
            <select
              data-testid="pipeline-attention-filter"
              value={attentionFilter}
              onChange={(e) => setAttentionFilter(e.target.value as AttentionFilter)}
              className="rounded-md border border-border bg-background px-2 py-0.5 text-foreground"
            >
              {ATTENTION_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f === 'any' ? `${ATTENTION_FILTER_LABEL[f]} (${attentionCount})` : ATTENTION_FILTER_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {scribe ? (
        <div data-testid="pipeline-scribe" className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
          <span>Pipeline scribe last ran {fmtTs(scribe.run_at)}</span>
          {unlinked.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {unlinked.map((a, i) => (
                <li key={i} data-testid="pipeline-unlinked-attention" className="flex flex-wrap items-baseline gap-2">
                  <PriorityBadge priority={a.priority} />
                  <span className="text-foreground">{a.company ?? 'No company'}</span>
                  <span>{a.reason}</span>
                  {a.hint ? <span className="italic">{a.hint}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 && rows.length > 0 ? (
        <p data-testid="pipeline-filter-empty" className="text-sm text-muted-foreground">
          No applications match these filters.{' '}
          <button
            type="button"
            data-testid="pipeline-filter-clear"
            onClick={() => {
              setStageFilter(null)
              setAttentionFilter('all')
            }}
            className="text-accent-cool hover:underline"
          >
            Clear filters
          </button>
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.application_id}
          rowTestId={(r) => `pipeline-row-${r.application_id}`}
          minWidthClass={caps.attention || caps.days || caps.email ? 'min-w-[60rem]' : 'min-w-[44rem]'}
          resetKey={`${activeStage ?? ''}|${attentionFilter}`}
          renderDetail={caps.detail ? (r) => <PipelineDetail row={r} baseUrl={baseUrl} /> : undefined}
          detailTestId="pipeline-detail"
          empty={<p className="text-sm text-muted-foreground">No applications in the pipeline yet.</p>}
        />
      )}
    </section>
  )
}

function PriorityBadge({ priority }: { priority: ScribePriority }) {
  const chip = PRIORITY_CHIP[priority]
  return (
    <span className={cn('inline-block whitespace-nowrap rounded border px-1.5 py-px font-mono text-[10px]', chip.tone)}>
      {chip.label}
    </span>
  )
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function transition(from: string | null, to: string | null): string | null {
  if (from && to) return `${from} → ${to}`
  return to ?? from
}

/** The row's read-only detail (§24.204 D2). Each block renders only when it has content. */
export function PipelineDetail({ row, baseUrl }: { row: AdminPipelineRow; baseUrl: string }) {
  const attention = row.attention ?? []
  const timeline = row.timeline ?? []
  const suggestions = row.suggestions ?? []
  const learnings = row.learnings ?? []
  const kits = row.kits ?? []
  const resumes = row.tailored_resumes ?? []
  const narrative = row.narrative ?? null
  const email = row.last_email ?? null
  const hasLinks = !!row.posting_url || !!row.active_kit_url || resumes.length > 0 || !!email

  const blocks: ReactNode[] = []

  if (row.win_confidence_rationale) {
    blocks.push(
      <Section key="why" title="Win confidence" testId="pipeline-detail-rationale">
        <p className="max-w-3xl text-[12px] leading-relaxed text-foreground">
          {row.win_confidence != null ? <span className="font-mono">{row.win_confidence}% · </span> : null}
          {row.win_confidence_rationale}
        </p>
      </Section>,
    )
  }

  if (attention.length > 0) {
    blocks.push(
      <Section key="attention" title="Needs attention" testId="pipeline-detail-attention">
        <ul className="flex flex-col gap-1 text-[12px]">
          {attention.map((a, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2">
              <PriorityBadge priority={a.priority} />
              <span className="text-foreground">{a.reason}</span>
              {a.hint ? <span className="text-muted-foreground">{a.hint}</span> : null}
            </li>
          ))}
        </ul>
      </Section>,
    )
  }

  if (timeline.length > 0) {
    blocks.push(
      <Section key="timeline" title="Stage timeline" testId="pipeline-detail-timeline">
        <ol className="flex flex-col gap-0.5 text-[12px]">
          {timeline.map((e) => (
            <li key={e.id} data-testid="pipeline-timeline-event" className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">{fmtTs(e.ts)}</span>
              <span className="text-foreground">{transition(e.from_status, e.to_status) ?? e.kind}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{e.source}</span>
              {e.summary ? <span className="text-muted-foreground">{e.summary}</span> : null}
            </li>
          ))}
        </ol>
      </Section>,
    )
  }

  if (narrative) {
    blocks.push(
      <Section key="narrative" title="Scribe's read" testId="pipeline-detail-narrative">
        <p className="max-w-3xl text-[12px] text-foreground">{narrative.current_state}</p>
        {narrative.timeline_excerpt.length > 0 ? (
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] text-muted-foreground">
            {narrative.timeline_excerpt.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
      </Section>,
    )
  }

  if (suggestions.length > 0) {
    blocks.push(
      <Section key="suggestions" title="Scribe suggestions" testId="pipeline-detail-suggestions">
        <ul className="flex flex-col gap-0.5 text-[12px]">
          {suggestions.map((s, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[11px] text-foreground">{s.action}</span>
              <span className="text-muted-foreground">{s.rationale}</span>
            </li>
          ))}
        </ul>
      </Section>,
    )
  }

  if (learnings.length > 0) {
    blocks.push(
      <Section key="learnings" title="Learnings" testId="pipeline-detail-learnings">
        <ul className="flex flex-col gap-0.5 text-[12px]">
          {learnings.map((l) => (
            <li key={l.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">{l.kind}</span>
              {l.published ? <span className="font-mono text-[10px] text-accent-cool">published</span> : null}
              <span className="text-foreground">{l.text}</span>
            </li>
          ))}
        </ul>
      </Section>,
    )
  }

  if (kits.length > 0) {
    blocks.push(
      <Section key="kits" title="Interview kits" testId="pipeline-detail-kits">
        <ul className="flex flex-col gap-0.5 text-[12px]">
          {kits.map((k) => (
            <li key={`${k.drive_url}|${k.created_at}`} className="flex flex-wrap items-baseline gap-2">
              <a href={k.drive_url} target="_blank" rel="noreferrer" className={linkClass}>
                {k.title} ↗
              </a>
              <span className="font-mono text-[10px] text-muted-foreground">
                {k.round} · {k.status}
                {k.interview_at ? ` · ${fmtTs(k.interview_at)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>,
    )
  }

  if (hasLinks) {
    blocks.push(
      <Section key="links" title="Links" testId="pipeline-detail-links">
        <div className="flex flex-wrap items-center gap-3">
          {row.posting_url ? (
            <a
              data-testid="pipeline-link-posting"
              href={row.posting_url}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              posting ↗
            </a>
          ) : null}
          {row.active_kit_url ? (
            <a
              data-testid="pipeline-link-kit"
              href={row.active_kit_url}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              active kit ↗
            </a>
          ) : null}
          {email ? (
            <a
              data-testid="pipeline-link-thread"
              href={email.thread_url}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
              title={[email.subject, email.from_addr, email.classification].filter(Boolean).join(' · ')}
            >
              mail thread ↗
            </a>
          ) : null}
        </div>
        {resumes.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {resumes.map((t) => {
              const sent = t.sent || (row.sent_resume_id != null && row.sent_resume_id === t.id)
              return (
                <li key={t.id} data-testid="pipeline-resume" data-sent={sent ? 'true' : 'false'}>
                  <a href={tailoredPdfUrl(baseUrl, t.id)} target="_blank" rel="noreferrer" className={linkClass}>
                    tailored résumé · {fmtTs(t.created_at)} ↗
                  </a>
                  {sent ? (
                    <span className="ml-2 rounded border border-accent-cool/60 px-1.5 py-px font-mono text-[10px] text-accent-cool">
                      sent
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </Section>,
    )
  }

  if (blocks.length === 0) {
    return <p className="text-[12px] text-muted-foreground">Nothing more recorded for this application yet.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {blocks}
      <p className="font-mono text-[10px] text-muted-foreground">
        Read-only — the pipeline scribe and the agent keep stages up to date.
      </p>
    </div>
  )
}
