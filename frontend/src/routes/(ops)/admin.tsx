import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { AdminModeControls } from '~/components/admin/AdminModeControls'
import { KnobControls } from '~/components/dev/KnobControls'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { cn } from '~/lib/utils'
import { seo } from '~/lib/seo'
import {
  artifactLabel,
  postAdminControl,
  postAdminKnob,
  resetAdminKnob,
  resetAllAdminKnobs,
  useAdminAttribution,
  useAdminContacts,
  useAdminKnobs,
  useAdminPipeline,
  useAdminSummary,
  type AdminAttributionLink,
  type AdminAttributionVisit,
  type AdminContact,
  type AdminPipelineRow,
  type AdminSummary,
} from '~/lib/use-admin'

// The owner-only `/admin` control-center (§24.138). Lives in the `(ops)` group
// (shared header/rail) but is NOT in the public nav — reached by direct URL. Every
// `/api/admin/*` endpoint 404s unless the admin surface is enabled (open on dev;
// prod fails closed until the /admin Access app is wired + admin_api_enabled), so
// on any other stack the page degrades to an "unavailable" note. `noindex`.
export const Route = createFileRoute('/(ops)/admin')({
  component: AdminPage,
  head: () => {
    const base = seo({
      title: 'Admin — control center',
      description: 'Owner-only operator control-center. Gated; served only behind Cloudflare Access.',
      path: '/admin',
    })
    return { meta: [...base.meta, { name: 'robots', content: 'noindex' }] }
  },
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

type TabId = 'overview' | 'pipeline' | 'visitors' | 'contacts' | 'system'
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'visitors', label: 'Visitors' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'system', label: 'System' },
]

function fmtTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`

function AdminPage() {
  const [tab, setTab] = useState<TabId>('overview')
  const summary = useAdminSummary(API_BASE)
  const pipeline = useAdminPipeline(API_BASE)
  const contacts = useAdminContacts(API_BASE)
  const knobs = useAdminKnobs(API_BASE)
  const attribution = useAdminAttribution(API_BASE)

  // Cold 404 on the summary feed = the admin surface is disabled (or not this
  // stack) → the whole page is unavailable. This is the prod-degradation path.
  const unavailable = summary.status === 'error' && summary.data === null
  const loading = summary.status === 'loading' && !summary.data

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Control center</h1>
          <span className="rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            owner-only
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          The operator cockpit — system health and cost at a glance, the live pipeline and inbound contacts, the visitor
          attribution feed, and every operational lever. Gated; served only behind Cloudflare Access.
        </p>
      </header>

      {unavailable ? (
        <div className="flex min-h-[16rem] items-center justify-center">
          <StateNote data-testid="admin-unavailable" tone="error">
            The admin surface is gated — served only behind Cloudflare Access (the dev stack, or the prod /admin app
            once enabled). Nothing to show here.
          </StateNote>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton data-testid="admin-skeleton" className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <nav
            className="sticky top-14 z-10 flex flex-wrap gap-1 border-b border-border bg-background"
            aria-label="Admin sections"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`admin-tab-${t.id}`}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
                className={cn(
                  '-mb-px rounded-t-md border-b-2 px-3 py-2 font-mono text-xs font-semibold transition-colors',
                  tab === t.id
                    ? 'border-accent-cool text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {tab === 'overview' ? <OverviewPanel summary={summary.data} /> : null}
          {tab === 'pipeline' ? (
            <PipelinePanel rows={pipeline.data?.applications ?? []} stageCounts={pipeline.data?.stageCounts ?? {}} />
          ) : null}
          {tab === 'visitors' ? <VisitorsPanel data={attribution.data} /> : null}
          {tab === 'contacts' ? <ContactsPanel contacts={contacts.data?.contacts ?? []} /> : null}
          {tab === 'system' ? (
            <section className="flex flex-col gap-4">
              {knobs.data ? (
                <KnobControls
                  knobs={knobs.data.knobs}
                  onWrite={(key, value) => postAdminKnob(API_BASE, key, value)}
                  onReset={(key) => resetAdminKnob(API_BASE, key)}
                  onResetAll={() => resetAllAdminKnobs(API_BASE)}
                />
              ) : null}
              <p className="text-[11px] leading-snug text-muted-foreground">
                Edge-tier abuse controls (Turnstile, the Workers rate-limit burst caps) live in{' '}
                <code className="font-mono">frontend/wrangler.jsonc</code> per environment — the Worker enforces them at
                the edge and can't read these host knobs (§24.70 D4). The recruiter-sim + dev-model knobs are excluded
                here by design (dev-only).
              </p>
            </section>
          ) : null}
        </>
      )}
    </main>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────

function OverviewPanel({ summary }: { summary: AdminSummary | null }) {
  const health = summary?.health
  const classes = summary ? (['ops', 'chat', 'sandbox', 'host'] as const) : []
  return (
    <section className="flex flex-col gap-4">
      <AdminModeControls mode={summary?.mode} onControl={(body) => postAdminControl(API_BASE, body)} />

      <div className="grid gap-4 md:grid-cols-2">
        {/* Health */}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Health</h2>
            <span className="font-mono text-[10px] text-muted-foreground">{health ? fmtTs(health.ranAt) : '—'}</span>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            The proactive `runHealthChecks` pass (live probes skipped) — each non-ok finding carries the exact command
            to fix it.
          </p>
          <div className="flex flex-wrap gap-2" data-testid="admin-health-counts">
            <Pill tone="ok" label={`ok ${health?.counts.ok ?? 0}`} />
            <Pill tone="warn" label={`warn ${health?.counts.warn ?? 0}`} />
            <Pill tone="alert" label={`critical ${health?.counts.critical ?? 0}`} />
          </div>
          {health && health.findings.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/60">
              {health.findings.map((f) => (
                <li key={f.id} className="flex flex-col gap-1 py-2" data-testid="admin-health-finding">
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        f.severity === 'critical' ? 'bg-destructive' : 'bg-amber-400',
                      )}
                    />
                    {f.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{f.detail}</span>
                  {f.next_step ? (
                    <code className="block overflow-x-auto whitespace-pre rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                      {f.next_step}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">All checks pass.</p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {/* Cost */}
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">24h spend</h2>
              <span
                className="font-mono text-sm font-semibold tabular-nums text-foreground"
                data-testid="admin-spend-total"
              >
                {summary ? usd(summary.spendTotalMicrousd24h) : '—'}
              </span>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              LLM spend over the last 24h, split by traffic class — ops (scheduled jobs) · chat (owner) · sandbox
              (public simulator) · host (sim prose, scoring).
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {classes.map((c) => (
                <div key={c} className="flex items-center justify-between gap-2">
                  <dt className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{c}</dt>
                  <dd className="font-mono text-xs tabular-nums text-foreground" data-testid={`admin-spend-${c}`}>
                    {summary ? usd(summary.spendByClass[c].microusd_24h) : '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Pool */}
          <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Container pool</h2>
              <span className="font-mono text-2xl font-semibold tabular-nums text-foreground" data-testid="admin-pool">
                {summary ? `${summary.pool.active} / ${summary.pool.capacity}` : '—'}
              </span>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Live agent containers vs the concurrency cap (<code className="font-mono">container_max_concurrent</code>,
              on System). Each warm container holds RAM + a slot until the idle reaper sweeps it.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function Pill({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'alert' }) {
  const dot = tone === 'ok' ? 'bg-primary' : tone === 'warn' ? 'bg-amber-400' : 'bg-destructive'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
}

// ── Pipeline (owner view — real names) ────────────────────────────────────────

function PipelinePanel({ rows, stageCounts }: { rows: AdminPipelineRow[]; stageCounts: Record<string, number> }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No applications in the pipeline yet.</p>
  }
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
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="py-2 pl-4 pr-4 font-mono font-normal">Company</th>
              <th className="py-2 pr-4 font-mono font-normal">Role</th>
              <th className="py-2 pr-4 font-mono font-normal">Stage</th>
              <th className="py-2 pr-4 text-right font-mono font-normal">Win</th>
              <th className="py-2 pr-4 font-mono font-normal">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.application_id} className="border-t border-border">
                <td className="py-2 pl-4 pr-4 text-foreground">
                  <span className="flex max-w-[16rem] items-baseline gap-2">
                    <span className="truncate" title={r.company_name ?? undefined}>
                      {r.company_name ?? '—'}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {r.obfuscated_label ?? ''}
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  <span className="block max-w-[14rem] truncate" title={r.role_title ?? undefined}>
                    {r.role_title ?? '—'}
                  </span>
                </td>
                <td className="py-2 pr-4 text-foreground">{r.stage}</td>
                <td className="py-2 pr-4 text-right font-mono tabular-nums text-foreground">
                  {r.win_confidence != null ? `${r.win_confidence}%` : '—'}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{fmtTs(r.last_activity_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Contacts (§24.121 store) ──────────────────────────────────────────────────

function ContactsPanel({ contacts }: { contacts: AdminContact[] }) {
  if (contacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No inbound contact submissions yet.</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
            <th className="py-2 pl-4 pr-4 font-mono font-normal">When</th>
            <th className="py-2 pr-4 font-mono font-normal">From</th>
            <th className="py-2 pr-4 font-mono font-normal">Company</th>
            <th className="py-2 pr-4 font-mono font-normal">Message</th>
            <th className="py-2 pr-4 font-mono font-normal">Sent</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr key={c.id} className="border-t border-border align-top" data-testid="admin-contact-row">
              <td className="py-2 pl-4 pr-4 font-mono text-xs text-muted-foreground">{fmtTs(c.createdAt)}</td>
              <td className="py-2 pr-4">
                <span className="block text-foreground">{c.name ?? '—'}</span>
                <span className="block break-all font-mono text-[11px] text-muted-foreground">{c.email ?? '—'}</span>
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                <span className="block max-w-[12rem] truncate" title={c.company ?? undefined}>
                  {c.company ?? '—'}
                </span>
                {c.role ? <span className="block text-[11px]">{c.role}</span> : null}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {/* Long messages clamp to 3 lines (full text on hover) so one verbose
                    submission can't blow out the row height / table width. */}
                <span className="line-clamp-3 block max-w-md break-words" title={c.message}>
                  {c.message}
                </span>
              </td>
              <td className="py-2 pr-4 font-mono text-xs">
                {c.delivered ? (
                  <span className="text-accent-cool">✓</span>
                ) : (
                  <span className="text-destructive">✕</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Visitors (the §24.74 attribution browser) ─────────────────────────────────

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
      <td className="max-w-[16rem] break-all py-2 pr-4 text-muted-foreground">{link.recipient ?? '—'}</td>
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
      <td className="max-w-[16rem] break-all py-1.5 pr-4 text-muted-foreground">{visit.referrer ?? 'direct'}</td>
    </tr>
  )
}

function VisitorsPanel({ data }: { data: ReturnType<typeof useAdminAttribution>['data'] }) {
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
    </div>
  )
}
