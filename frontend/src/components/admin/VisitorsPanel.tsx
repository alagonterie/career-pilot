import { fmtTs } from '~/lib/admin-format'
import {
  artifactLabel,
  type AdminAttributionLink,
  type AdminAttributionReport,
  type AdminAttributionVisit,
} from '~/lib/use-admin'

import { DataTable, type Column } from './DataTable'

/**
 * The `/admin` Visitors tab (the §24.74 attribution browser; migrated onto the
 * shared DataTable §24.174). A stat strip + two tables — minted links and the
 * recent-visit log (the unbounded one, where pagination earns its keep).
 */

const LINK_COLUMNS: Column<AdminAttributionLink>[] = [
  {
    id: 'source',
    header: 'Source',
    cell: (l) => (
      <>
        <span className="text-foreground">{artifactLabel(l.artifactType)}</span>
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">/r/{l.code}</span>
      </>
    ),
  },
  { id: 'company', header: 'Company', cellClassName: 'text-foreground', cell: (l) => l.company ?? '—' },
  {
    id: 'recipient',
    header: 'Recipient',
    cellClassName: 'max-w-[16rem] break-all text-muted-foreground',
    cell: (l) => l.recipient ?? '—',
  },
  {
    id: 'clicks',
    header: 'Clicks',
    align: 'right',
    cellClassName: 'font-mono tabular-nums text-foreground',
    sort: (l) => l.clicks,
    cell: (l) => l.clicks,
  },
  {
    id: 'unique',
    header: 'Unique',
    align: 'right',
    cellClassName: 'font-mono tabular-nums text-foreground',
    sort: (l) => l.uniqueVisitors,
    cell: (l) => l.uniqueVisitors,
  },
  {
    id: 'lastclick',
    header: 'Last click',
    cellClassName: 'font-mono text-xs text-muted-foreground',
    sort: (l) => (l.lastClickAt ? new Date(l.lastClickAt).getTime() : 0),
    cell: (l) => fmtTs(l.lastClickAt),
  },
]

const VISIT_COLUMNS: Column<AdminAttributionVisit>[] = [
  {
    id: 'when',
    header: 'When',
    cellClassName: 'font-mono text-xs text-muted-foreground',
    sort: (v) => (v.ts ? new Date(v.ts).getTime() : 0),
    cell: (v) => fmtTs(v.ts),
  },
  { id: 'company', header: 'Company', cellClassName: 'text-foreground', cell: (v) => v.company ?? '—' },
  { id: 'country', header: 'Country', cellClassName: 'text-muted-foreground', cell: (v) => v.country ?? '—' },
  { id: 'device', header: 'Device', cellClassName: 'text-muted-foreground', cell: (v) => v.uaClass ?? '—' },
  {
    id: 'referrer',
    header: 'Referrer',
    cellClassName: 'max-w-[16rem] break-all text-muted-foreground',
    cell: (v) => v.referrer ?? 'direct',
  },
]

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

export function VisitorsPanel({ data }: { data: AdminAttributionReport | null }) {
  if (!data) return <p className="text-sm text-muted-foreground">No attribution data yet.</p>
  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Links" value={data.summary.totalLinks} />
        <Stat label="Clicks" value={data.summary.totalClicks} />
        <Stat label="Unique" value={data.summary.totalUniqueVisitors} />
        <Stat label="Top country" value={data.summary.topCountries[0] ? data.summary.topCountries[0].country : '—'} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Links</h2>
        <DataTable
          columns={LINK_COLUMNS}
          rows={data.links}
          rowKey={(l) => l.code}
          minWidthClass="min-w-[40rem]"
          empty={
            <p className="text-sm text-muted-foreground">
              No links minted yet. They're created automatically when the agent drafts outreach or renders the master
              résumé.
            </p>
          }
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Recent visits</h2>
        <DataTable
          columns={VISIT_COLUMNS}
          rows={data.recentVisits}
          rowKey={(v, i) => `${v.ts}-${i}`}
          minWidthClass="min-w-[36rem]"
          empty={<p className="text-sm text-muted-foreground">No clicks recorded yet.</p>}
        />
      </section>
    </div>
  )
}
