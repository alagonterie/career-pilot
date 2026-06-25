import { createFileRoute } from '@tanstack/react-router'

import { AdminModeControls } from '~/components/admin/AdminModeControls'
import { ContactsPanel } from '~/components/admin/ContactsPanel'
import { LeadsPanel } from '~/components/admin/LeadsPanel'
import { ModelControls } from '~/components/admin/ModelControls'
import { PersonaPanel } from '~/components/admin/PersonaPanel'
import { PipelinePanel } from '~/components/admin/PipelinePanel'
import { SandboxRunsPanel } from '~/components/admin/SandboxRunsPanel'
import { VisitorsPanel } from '~/components/admin/VisitorsPanel'
import { KnobControls } from '~/components/dev/KnobControls'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { fmtTs, usd } from '~/lib/admin-format'
import { cn } from '~/lib/utils'
import { seo } from '~/lib/seo'
import {
  deleteAdminSandboxRun,
  postAdminControl,
  postAdminKnob,
  resetAdminKnob,
  resetAllAdminKnobs,
  useAdminAttribution,
  useAdminContacts,
  useAdminKnobs,
  useAdminLeads,
  useAdminPersona,
  useAdminPipeline,
  useAdminSandboxRuns,
  useAdminSummary,
  type AdminSummary,
} from '~/lib/use-admin'

type TabId = 'overview' | 'pipeline' | 'leads' | 'visitors' | 'contacts' | 'sandbox' | 'models' | 'persona' | 'system'
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'leads', label: 'Leads' },
  { id: 'visitors', label: 'Visitors' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'models', label: 'Models' },
  { id: 'persona', label: 'Persona' },
  { id: 'system', label: 'System' },
]

// §24.176: the active tab lives in the URL (`?tab=<id>`) so tabs are deep-linkable
// and browser back/forward step through them. `overview` is the default and stays
// param-free (a clean `/admin`); an unknown tab also falls back to overview.
function normalizeTab(v: unknown): TabId | undefined {
  return typeof v === 'string' && v !== 'overview' && TABS.some((t) => t.id === v) ? (v as TabId) : undefined
}

// The owner-only `/admin` control-center (§24.138). Lives in the `(ops)` group
// (shared header/rail) but is NOT in the public nav — reached by direct URL. Every
// `/api/admin/*` endpoint 404s unless the admin surface is enabled (open on dev;
// prod fails closed until the /admin Access app is wired + admin_api_enabled), so
// on any other stack the page degrades to an "unavailable" note. `noindex`.
export const Route = createFileRoute('/(ops)/admin')({
  component: AdminPage,
  // `?tab=<id>` drives the active tab (§24.176): deep-linkable + back/forward nav.
  validateSearch: (search: Record<string, unknown>): { tab?: TabId } => ({ tab: normalizeTab(search.tab) }),
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

function AdminPage() {
  const tab: TabId = Route.useSearch().tab ?? 'overview'
  const navigate = Route.useNavigate()
  const summary = useAdminSummary(API_BASE)
  const pipeline = useAdminPipeline(API_BASE)
  const contacts = useAdminContacts(API_BASE)
  const knobs = useAdminKnobs(API_BASE)
  const attribution = useAdminAttribution(API_BASE)
  const sandboxRuns = useAdminSandboxRuns(API_BASE)
  const persona = useAdminPersona(API_BASE)
  const leads = useAdminLeads(API_BASE)

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
                onClick={() => navigate({ search: t.id === 'overview' ? {} : { tab: t.id }, resetScroll: false })}
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

          {tab === 'overview' ? <OverviewPanel summary={summary.data} onModeChange={summary.refresh} /> : null}
          {tab === 'pipeline' ? (
            <PipelinePanel rows={pipeline.data?.applications ?? []} stageCounts={pipeline.data?.stageCounts ?? {}} />
          ) : null}
          {tab === 'leads' ? <LeadsPanel data={leads.data ?? null} baseUrl={API_BASE} onSaved={leads.refresh} /> : null}
          {tab === 'visitors' ? <VisitorsPanel data={attribution.data} /> : null}
          {tab === 'contacts' ? <ContactsPanel contacts={contacts.data?.contacts ?? []} /> : null}
          {tab === 'sandbox' ? (
            <SandboxRunsPanel
              data={sandboxRuns.data}
              onDelete={async (id) => {
                const res = await deleteAdminSandboxRun(API_BASE, id)
                if (res.ok) sandboxRuns.refresh() // drop the row immediately, no manual refresh
                return res
              }}
            />
          ) : null}
          {tab === 'models' ? (
            <section className="flex flex-col gap-4">
              {knobs.data ? (
                <ModelControls
                  knobs={knobs.data.knobs.filter((k) => k.group === 'models')}
                  onWrite={(key, value) => postAdminKnob(API_BASE, key, value)}
                  onReset={(key) => resetAdminKnob(API_BASE, key)}
                />
              ) : null}
              <p className="text-[11px] leading-snug text-muted-foreground">
                The recruiter-sim prose model is dev-only (excluded here by design); the model feature <em>toggles</em>{' '}
                (kit entity-redact, sanitization pass-3) stay on the System tab — these are the model <em>choices</em>{' '}
                only.
              </p>
            </section>
          ) : null}
          {tab === 'persona' ? (
            <PersonaPanel data={persona.data ?? null} baseUrl={API_BASE} onSaved={persona.refresh} />
          ) : null}
          {tab === 'system' ? (
            <section className="flex flex-col gap-4">
              {knobs.data ? (
                <KnobControls
                  knobs={knobs.data.knobs.filter((k) => k.group !== 'models')}
                  onWrite={(key, value) => postAdminKnob(API_BASE, key, value)}
                  onReset={(key) => resetAdminKnob(API_BASE, key)}
                  onResetAll={() => resetAllAdminKnobs(API_BASE)}
                />
              ) : null}
              <p className="text-[11px] leading-snug text-muted-foreground">
                Edge-tier abuse controls (Turnstile, the Workers rate-limit burst caps) live in{' '}
                <code className="font-mono">frontend/wrangler.jsonc</code> per environment — the Worker enforces them at
                the edge and can't read these host knobs (§24.70 D4). Model choices moved to the <strong>Models</strong>{' '}
                tab; the recruiter-sim knobs are excluded here by design (dev-only).
              </p>
            </section>
          ) : null}
        </>
      )}
    </main>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────

function OverviewPanel({ summary, onModeChange }: { summary: AdminSummary | null; onModeChange: () => void }) {
  const health = summary?.health
  const classes = summary ? (['ops', 'chat', 'sandbox', 'host'] as const) : []
  return (
    <section className="flex flex-col gap-4">
      <AdminModeControls
        mode={summary?.mode}
        onControl={async (body) => {
          const res = await postAdminControl(API_BASE, body)
          // Refetch the summary so the Mode / Run-state badges flip immediately —
          // no manual page refresh (the poll alone left them stale for up to 20s).
          if (res.ok) onModeChange()
          return res
        }}
      />

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
