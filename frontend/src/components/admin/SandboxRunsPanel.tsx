import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { cn } from '~/lib/utils'
import type { AdminSandboxRun, AdminSandboxRunsView, AdminWriteResult } from '~/lib/use-admin'

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
 * company/role free-text, the JD excerpt, cost/runtime, a per-source token) to
 * monitor usage + abuse + quality. Per-row: open the result page, or confirm-delete
 * to purge that run's stored input before its TTL. No raw IP is ever shown.
 */
export function SandboxRunsPanel({
  data,
  onDelete,
}: {
  data: AdminSandboxRunsView | null
  onDelete: (id: string) => Promise<AdminWriteResult>
}) {
  const runs = data?.runs ?? []
  const stats = data?.stats
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

      {runs.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          No sandbox runs stored.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pl-4 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Company</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 text-right font-medium">Cost</th>
                <th className="py-2 pr-4 text-right font-medium">Runtime</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RunRow({ run, onDelete }: { run: AdminSandboxRun; onDelete: (id: string) => Promise<AdminWriteResult> }) {
  const [open, setOpen] = React.useState(false)
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

  return (
    <>
      <tr data-testid={`sandbox-run-${run.id}`}>
        <td className="py-2 pl-4 pr-4 font-mono text-xs tabular-nums text-muted-foreground">{fmtWhen(run.ts)}</td>
        <td className="py-2 pr-4 text-foreground">{run.visitor_company ?? '—'}</td>
        <td className="py-2 pr-4 text-foreground">{run.visitor_role ?? '—'}</td>
        <td className="py-2 pr-4 text-right font-mono tabular-nums text-foreground">{fmtCost(run.total_cost_cents)}</td>
        <td className="py-2 pr-4 text-right font-mono tabular-nums text-muted-foreground">
          {fmtDur(run.total_latency_ms)}
        </td>
        <td className="py-2 pr-4">
          <span
            className={cn(
              'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] uppercase',
              run.status === 'completed' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {run.status}
          </span>
        </td>
        <td className="py-2 pr-4 font-mono text-[11px] text-muted-foreground">{source(run.ip_token)}</td>
        <td className="py-2 pr-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={`sandbox-run-details-${run.id}`}
              onClick={() => setOpen((v) => !v)}
              className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              {open ? 'Hide' : 'Details'}
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
                className="font-mono text-[11px] text-destructive/80 hover:text-destructive"
              >
                Delete
              </button>
            )}
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="bg-muted/30">
          <td colSpan={8} className="px-4 py-3">
            <div className="flex flex-col gap-2 text-xs">
              <div>
                <span className="font-semibold text-foreground">What they entered (JD excerpt):</span>{' '}
                <span className="text-muted-foreground">{run.jd_excerpt ? run.jd_excerpt : '— none —'}</span>
              </div>
              <Link
                to="/watch/results/$id"
                params={{ id: run.id }}
                className="w-fit font-mono text-[11px] text-accent-cool hover:underline"
              >
                Open the result page ↗
              </Link>
              {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
            </div>
          </td>
        </tr>
      ) : error && !open ? (
        <tr>
          <td colSpan={8} className="px-4 pb-2">
            <span className="text-[11px] text-destructive">{error}</span>
          </td>
        </tr>
      ) : null}
    </>
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
