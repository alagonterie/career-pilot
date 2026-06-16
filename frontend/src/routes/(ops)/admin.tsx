import { createFileRoute } from '@tanstack/react-router'

import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { seo } from '~/lib/seo'
import {
  artifactLabel,
  useAdminAttribution,
  type AdminAttributionLink,
  type AdminAttributionVisit,
} from '~/lib/use-admin'

// The owner-only visitor-attribution browser (§24.74 D5). Lives in the `(ops)`
// group (shared header/rail) but is NOT in the public nav — reached by direct
// URL. The backend `/api/admin/*` endpoints 404 unless the admin surface is
// enabled (open on the dev stack; prod fails closed until the /admin Access app
// is wired), so on any other stack this page degrades to an "unavailable" note.
// `noindex` keeps it out of search.
export const Route = createFileRoute('/(ops)/admin')({
  component: AdminPage,
  head: () => {
    const base = seo({
      title: 'Admin — visitor attribution',
      description: 'Owner-only visitor-attribution browser. Gated; served only behind Cloudflare Access.',
      path: '/admin',
    })
    return { meta: [...base.meta, { name: 'robots', content: 'noindex' }] }
  },
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

/** Compact LOCAL-time timestamp. Only ever rendered client-side (the feed loads
 *  via a client poll, so it's never in the SSR HTML) — so the viewer's own zone
 *  is hydration-safe and the right thing to show the owner. */
function fmtTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function LinkRow({ link }: { link: AdminAttributionLink }) {
  return (
    <tr className="border-t border-border">
      <td className="py-2 pl-4 pr-4">
        <span className="text-foreground">{artifactLabel(link.artifactType)}</span>
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">/r/{link.code}</span>
      </td>
      <td className="py-2 pr-4 text-foreground">{link.company ?? '—'}</td>
      <td className="py-2 pr-4 text-muted-foreground">{link.recipient ?? '—'}</td>
      <td className="py-2 pr-4 text-right font-mono tabular-nums text-foreground">{link.clicks}</td>
      <td className="py-2 pr-4 text-right font-mono tabular-nums text-foreground">{link.uniqueVisitors}</td>
      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{fmtTs(link.lastClickAt)}</td>
    </tr>
  )
}

function VisitRow({ visit }: { visit: AdminAttributionVisit }) {
  return (
    <tr className="border-t border-border">
      <td className="py-1.5 pl-4 pr-4 font-mono text-xs text-muted-foreground">{fmtTs(visit.ts)}</td>
      <td className="py-1.5 pr-4 text-foreground">{visit.company ?? '—'}</td>
      <td className="py-1.5 pr-4 text-muted-foreground">{visit.country ?? '—'}</td>
      <td className="py-1.5 pr-4 text-muted-foreground">{visit.uaClass ?? '—'}</td>
      <td className="py-1.5 pr-4 text-muted-foreground">{visit.referrer ?? 'direct'}</td>
    </tr>
  )
}

function AdminPage() {
  const report = useAdminAttribution(API_BASE)
  const unavailable = report.status === 'error' && report.data === null
  const data = report.data

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Visitor attribution</h1>
          <span className="rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            owner-only
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Who clicked through from an outbound artifact — an outreach email or a forwarded résumé — and from where.
          First-party only: a salted IP hash, coarse country, and the referrer host. No third-party trackers.
        </p>
      </header>

      {unavailable ? (
        <div className="flex min-h-[16rem] items-center justify-center">
          <StateNote data-testid="admin-unavailable" tone="error">
            The admin surface is gated — served only behind Cloudflare Access (the dev stack, or the prod /admin app
            once enabled). Nothing to show here.
          </StateNote>
        </div>
      ) : report.status === 'loading' && !data ? (
        <div className="flex flex-col gap-4">
          <Skeleton data-testid="admin-skeleton" className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : data ? (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Links" value={data.summary.totalLinks} />
            <Stat label="Clicks" value={data.summary.totalClicks} />
            <Stat label="Unique" value={data.summary.totalUniqueVisitors} />
            <Stat
              label="Top country"
              value={data.summary.topCountries[0] ? data.summary.topCountries[0].country : '—'}
            />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Links</h2>
            {data.links.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No links minted yet. They're created automatically when the agent drafts outreach or renders the master
                résumé.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="py-2 pl-4 pr-4 font-mono font-normal">Source</th>
                      <th className="py-2 pr-4 font-mono font-normal">Company</th>
                      <th className="py-2 pr-4 font-mono font-normal">Recipient</th>
                      <th className="py-2 pr-4 text-right font-mono font-normal">Clicks</th>
                      <th className="py-2 pr-4 text-right font-mono font-normal">Unique</th>
                      <th className="py-2 pr-4 font-mono font-normal">Last click</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.links.map((l) => (
                      <LinkRow key={l.code} link={l} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Recent visits</h2>
            {data.recentVisits.length === 0 ? (
              <p className="text-sm text-muted-foreground">No clicks recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="py-2 pl-4 pr-4 font-mono font-normal">When</th>
                      <th className="py-2 pr-4 font-mono font-normal">Company</th>
                      <th className="py-2 pr-4 font-mono font-normal">Country</th>
                      <th className="py-2 pr-4 font-mono font-normal">Device</th>
                      <th className="py-2 pr-4 font-mono font-normal">Referrer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentVisits.map((v, i) => (
                      <VisitRow key={`${v.ts}-${i}`} visit={v} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  )
}
