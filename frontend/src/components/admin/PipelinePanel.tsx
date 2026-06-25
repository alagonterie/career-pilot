import { fmtTs } from '~/lib/admin-format'
import type { AdminPipelineRow } from '~/lib/use-admin'

import { DataTable, type Column } from './DataTable'

/**
 * The `/admin` Pipeline tab (§24.138; migrated onto the shared DataTable §24.174).
 * The OWNER view of the application pipeline — real company names (the public
 * surface is anonymized to obfuscated_label). A stage-count strip + the table.
 */

const COLUMNS: Column<AdminPipelineRow>[] = [
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
  {
    id: 'win',
    header: 'Win',
    align: 'right',
    cellClassName: 'font-mono tabular-nums text-foreground',
    sort: (r) => r.win_confidence ?? -1,
    cell: (r) => (r.win_confidence != null ? `${r.win_confidence}%` : '—'),
  },
  {
    id: 'last',
    header: 'Last activity',
    cellClassName: 'font-mono text-xs text-muted-foreground',
    sort: (r) => (r.last_activity_at ? new Date(r.last_activity_at).getTime() : 0),
    cell: (r) => fmtTs(r.last_activity_at),
  },
]

export function PipelinePanel({
  rows,
  stageCounts,
}: {
  rows: AdminPipelineRow[]
  stageCounts: Record<string, number>
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(stageCounts).map(([stage, n]) => (
          <span
            key={stage}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {stage}
            <span className="font-semibold tabular-nums text-foreground">{n}</span>
          </span>
        ))}
      </div>
      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.application_id}
        minWidthClass="min-w-[44rem]"
        empty={<p className="text-sm text-muted-foreground">No applications in the pipeline yet.</p>}
      />
    </section>
  )
}
