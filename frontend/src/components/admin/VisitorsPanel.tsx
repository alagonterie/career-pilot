import { useMemo, useState } from 'react'

import { fmtTs } from '~/lib/admin-format'
import {
  artifactLabel,
  postAdminAttribution,
  type AdminAttributionLink,
  type AdminAttributionReport,
  type AdminAttributionVisit,
} from '~/lib/use-admin'

import { DataTable, type Column } from './DataTable'

/**
 * The `/admin` Visitors tab (the §24.74 attribution browser; the shared DataTable
 * §24.174; the §24.177 owner-minting write surface). A stat strip + the "new
 * source" minter + two tables — the minted links (with per-source actions) and the
 * recent-visit log.
 *
 * §24.177: an owner mints a NAMED source (a transparent `?from=<slug>` link), then
 * uses it two ways — paste the link (LinkedIn, a bio) AND hand out a résumé PDF
 * footed with the same source — so each channel's clicks attribute distinctly. The
 * auto-minted master/outreach links stay too (the master is the one fixed named
 * source; outreach stays opaque per-recipient).
 */

const SLUG_RE = /^[a-z0-9_]{1,40}$/

/** True for a soft-retired source — its `?from=` no longer attributes (history kept). */
function isRetired(l: AdminAttributionLink): boolean {
  return l.expiresAt != null && new Date(l.expiresAt).getTime() <= Date.now()
}

// The data columns (no component state); the Actions column is built in-component
// so it can close over the mint/retire handlers + the portal origin.
const DATA_COLUMNS: Column<AdminAttributionLink>[] = [
  {
    id: 'source',
    header: 'Source',
    cell: (l) => (
      <>
        <span className={isRetired(l) ? 'text-muted-foreground line-through' : 'text-foreground'}>
          {artifactLabel(l.artifactType)}
        </span>
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
          {l.artifactType === 'outreach' ? `/r/${l.code}` : `?from=${l.code}`}
        </span>
        {isRetired(l) ? (
          <span
            data-testid={`visitors-retired-${l.code}`}
            className="ml-2 rounded border border-border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
          >
            retired
          </span>
        ) : null}
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

function btnClass(): string {
  return 'rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50'
}

/** Per-source actions: copy the transparent link, download a footed résumé PDF, retire. */
function LinkActions({
  link,
  baseUrl,
  busy,
  copied,
  onCopy,
  onRetire,
}: {
  link: AdminAttributionLink
  baseUrl: string
  busy: string | null
  copied: string | null
  onCopy: (code: string) => void
  onRetire: (code: string) => void
}) {
  // Outreach is opaque + per-recipient (a 1:1 send) — no broadcast link/PDF here.
  if (link.artifactType === 'outreach') return <span className="text-muted-foreground">—</span>
  if (isRetired(link)) return <span className="font-mono text-[11px] text-muted-foreground">—</span>
  const canRetire = link.artifactType === 'owner_source'
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <button
        type="button"
        data-testid={`visitors-copy-${link.code}`}
        onClick={() => onCopy(link.code)}
        className={btnClass()}
        title={`Copy the ?from=${link.code} link`}
      >
        {copied === link.code ? 'Copied' : 'Copy link'}
      </button>
      <a
        data-testid={`visitors-download-${link.code}`}
        href={`${baseUrl}/api/admin/attribution/${link.code}/resume.pdf`}
        download={`resume-${link.code}.pdf`}
        className={btnClass()}
        title="Download the master résumé footed with this source"
      >
        Résumé PDF
      </a>
      {canRetire ? (
        <button
          type="button"
          data-testid={`visitors-retire-${link.code}`}
          disabled={busy != null}
          onClick={() => onRetire(link.code)}
          className={btnClass()}
          title="Stop this source attributing new visits (keeps its history)"
        >
          {busy === `retire-${link.code}` ? 'Retiring…' : 'Retire'}
        </button>
      ) : null}
    </div>
  )
}

export function VisitorsPanel({
  data,
  baseUrl,
  onSaved,
}: {
  data: AdminAttributionReport | null
  baseUrl: string
  onSaved: () => void
}) {
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const slugValid = SLUG_RE.test(slug)

  const mint = async (): Promise<void> => {
    if (!slugValid) return
    setBusy('mint')
    setError(null)
    const res = await postAdminAttribution(baseUrl, { action: 'mint', slug })
    setBusy(null)
    if (!res.ok) setError(res.error ?? `mint failed (${res.status})`)
    else {
      setSlug('')
      onSaved()
    }
  }

  const retire = async (code: string): Promise<void> => {
    setBusy(`retire-${code}`)
    setError(null)
    const res = await postAdminAttribution(baseUrl, { action: 'retire', slug: code })
    setBusy(null)
    if (!res.ok) setError(res.error ?? `retire failed (${res.status})`)
    else onSaved()
  }

  const copy = (code: string): void => {
    const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/?from=${code}`
    void navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(code)
    window.setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500)
  }

  // The actions column closes over the live handlers (the data columns stay static).
  const columns = useMemo<Column<AdminAttributionLink>[]>(
    () => [
      ...DATA_COLUMNS,
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (l) => (
          <LinkActions link={l} baseUrl={baseUrl} busy={busy} copied={copied} onCopy={copy} onRetire={retire} />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl, busy, copied],
  )

  if (!data) return <p className="text-sm text-muted-foreground">No attribution data yet.</p>

  return (
    <div data-testid="visitors-panel" className="flex flex-col gap-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Links" value={data.summary.totalLinks} />
        <Stat label="Clicks" value={data.summary.totalClicks} />
        <Stat label="Unique" value={data.summary.totalUniqueVisitors} />
        <Stat label="Top country" value={data.summary.topCountries[0] ? data.summary.topCountries[0].country : '—'} />
      </section>

      {/* Mint a named source (§24.177 D5) — the first write on this surface. */}
      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">New source</h2>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Mint a named visit source — a transparent <code className="font-mono">?from=&lt;name&gt;</code> link you can
          post anywhere AND hand out as a résumé PDF, both attributing to it. Lowercase letters, digits, underscores.
        </p>
        <form
          data-testid="visitors-mint-form"
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void mint()
          }}
        >
          <input
            type="text"
            inputMode="text"
            placeholder="e.g. linkedin_profile"
            value={slug}
            data-testid="visitors-mint-slug"
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className="w-56 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            data-testid="visitors-mint-submit"
            disabled={!slugValid || busy === 'mint'}
            className={btnClass()}
          >
            {busy === 'mint' ? 'Adding…' : 'Add source'}
          </button>
        </form>
        {error ? (
          <p data-testid="visitors-mint-error" className="font-mono text-[11px] text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Links</h2>
        <DataTable
          columns={columns}
          rows={data.links}
          rowKey={(l) => l.code}
          minWidthClass="min-w-[48rem]"
          empty={
            <p className="text-sm text-muted-foreground">
              No links yet. Mint one above, or they appear automatically when the agent drafts outreach or renders the
              master résumé.
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
