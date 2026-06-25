import * as React from 'react'

import { cn } from '~/lib/utils'
import type { AdminSandboxRun, AdminSandboxRunsView, AdminWriteResult } from '~/lib/use-admin'

import { DataTable, type CellContext, type Column } from './DataTable'

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtCost(cents: number | null): string {
  return cents == null ? '—' : `$${(cents / 100).toFixed(2)}`
}
function fmtDur(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
/** A short prefix of the salted IP token — enough to eyeball repeat sources, not the address. */
function source(token: string | null): string {
  return token ? token.slice(0, 6) : '—'
}

/**
 * §24.164 — the owner-only Sandbox-runs tab. The INVERSE of the public §24.162
 * metrics-only feed: behind Access, the owner sees the full run (the visitor's raw
 * company/role free-text, the full JD they entered, cost/runtime, a per-source
 * token) to monitor usage + abuse + quality. Per-row: open the result page in a new
 * tab, or confirm-delete to purge that run's stored input before its TTL. No raw IP
 * is ever shown.
 *
 * Migrated onto the shared DataTable (§24.174) for pagination + a consistent shell.
 * The row carries its own controls (Open / Delete) so the disclosure is driven by the
 * Details button via the cell context, not a row click; `tableFixed` + per-column
 * widths keep the data columns from reflowing as the Delete confirm changes width.
 */
const DATA_COLUMNS: Column<AdminSandboxRun>[] = [
  {
    id: 'when',
    header: 'When',
    headerClassName: 'w-28',
    cellClassName: 'font-mono text-xs tabular-nums text-muted-foreground',
    sort: (r) => (r.ts ? new Date(r.ts).getTime() : 0),
    cell: (r) => fmtWhen(r.ts),
  },
  {
    id: 'company',
    header: 'Company',
    cellClassName: 'text-foreground',
    cell: (r) => (
      <span className="block truncate" title={r.visitor_company ?? undefined}>
        {r.visitor_company ?? '—'}
      </span>
    ),
  },
  {
    id: 'role',
    header: 'Role',
    cellClassName: 'text-foreground',
    cell: (r) => (
      <span className="block truncate" title={r.visitor_role ?? undefined}>
        {r.visitor_role ?? '—'}
      </span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    align: 'right',
    headerClassName: 'w-16',
    cellClassName: 'font-mono tabular-nums text-foreground',
    sort: (r) => r.total_cost_cents ?? -1,
    cell: (r) => fmtCost(r.total_cost_cents),
  },
  {
    id: 'runtime',
    header: 'Runtime',
    align: 'right',
    headerClassName: 'w-20',
    cellClassName: 'font-mono tabular-nums text-muted-foreground',
    sort: (r) => r.total_latency_ms ?? -1,
    cell: (r) => fmtDur(r.total_latency_ms),
  },
  {
    id: 'status',
    header: 'Status',
    headerClassName: 'w-24',
    cell: (r) => (
      <span
        className={cn(
          'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] uppercase',
          r.status === 'completed' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {r.status}
      </span>
    ),
  },
  {
    id: 'source',
    header: 'Source',
    headerClassName: 'w-16',
    cellClassName: 'font-mono text-[11px] text-muted-foreground',
    cell: (r) => source(r.ip_token),
  },
]

export function SandboxRunsPanel({
  data,
  onDelete,
}: {
  data: AdminSandboxRunsView | null
  onDelete: (id: string) => Promise<AdminWriteResult>
}) {
  const runs = data?.runs ?? []
  const stats = data?.stats
  // The actions column closes over `onDelete`; the data columns are static.
  const columns = React.useMemo<Column<AdminSandboxRun>[]>(
    () => [
      ...DATA_COLUMNS,
      {
        id: 'actions',
        header: 'Actions',
        headerClassName: 'w-[15rem]',
        cell: (r, ctx) => <RunActions run={r} ctx={ctx} onDelete={onDelete} />,
      },
    ],
    [onDelete],
  )
  return (
    <section className="flex flex-col gap-4">
      {/* Aggregate header — cross-checks the Overview `sandbox` spend + the public feed. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Runs today" value={stats ? String(stats.runsToday) : '—'} />
        <Stat label="Spend today" value={stats ? fmtCost(stats.costTodayCents) : '—'} />
        <Stat label="Runs · 7d" value={stats ? String(stats.runs7d) : '—'} />
        <Stat label="Total stored" value={stats ? String(stats.total) : '—'} />
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">
        Every public “watch it work” run, owner-only — the visitor’s raw company/role is shown here (the public “recent
        runs” feed shows aggregate cost + runtime only). Source is a salted token, not an IP. Delete purges a run’s
        stored input before its TTL.
      </p>

      <DataTable
        columns={columns}
        rows={runs}
        rowKey={(r) => r.id}
        rowTestId={(r) => `sandbox-run-${r.id}`}
        tableFixed
        minWidthClass="min-w-[58rem]"
        expandOnRowClick={false}
        renderDetail={(r) => <RunDetail run={r} />}
        empty={
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No sandbox runs stored.
          </p>
        }
      />
    </section>
  )
}

function RunDetail({ run }: { run: AdminSandboxRun }) {
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <span className="font-semibold text-foreground">What they entered (job description):</span>
      {run.jd_excerpt ? (
        <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-background px-3 py-2 font-sans text-[11px] leading-snug text-muted-foreground">
          {run.jd_excerpt}
        </pre>
      ) : (
        <span className="text-muted-foreground">— none entered —</span>
      )}
    </div>
  )
}

function RunActions({
  run,
  ctx,
  onDelete,
}: {
  run: AdminSandboxRun
  ctx: CellContext
  onDelete: (id: string) => Promise<AdminWriteResult>
}) {
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const del = async () => {
    setBusy(true)
    setError(null)
    const res = await onDelete(run.id)
    setBusy(false)
    setConfirming(false)
    if (!res.ok) setError(res.error ?? `HTTP ${res.status}`)
  }

  const actionBtn = 'font-mono text-[11px]'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <a
          href={`/watch/results/${run.id}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`sandbox-run-open-${run.id}`}
          className={cn(actionBtn, 'text-accent-cool hover:underline')}
        >
          Open ↗
        </a>
        <button
          type="button"
          data-testid={`sandbox-run-details-${run.id}`}
          onClick={ctx.toggle}
          className={cn(actionBtn, 'text-muted-foreground hover:text-foreground')}
        >
          {ctx.expanded ? 'Hide' : 'Details'}
        </button>
        {confirming ? (
          <span className="flex items-center gap-1.5" data-testid={`sandbox-run-confirm-${run.id}`}>
            <button
              type="button"
              data-testid={`sandbox-run-delete-yes-${run.id}`}
              onClick={() => void del()}
              disabled={busy}
              className="rounded bg-destructive px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white hover:bg-destructive/90 disabled:opacity-40"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid={`sandbox-run-delete-${run.id}`}
            onClick={() => setConfirming(true)}
            className={cn(actionBtn, 'text-destructive/80 hover:text-destructive')}
          >
            Delete
          </button>
        )}
      </div>
      {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}
