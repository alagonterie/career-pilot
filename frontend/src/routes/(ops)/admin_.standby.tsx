import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { seo } from '~/lib/seo'
import { getStandbyView } from '~/lib/standby-server'
import type { StandbySnapshot, StandbyState } from '~/lib/standby'
import { cn } from '~/lib/utils'

/**
 * The standby console (§24.189) — the "simplified admin page that still works when
 * GCP is torn down."
 *
 * Everything here is EDGE-ONLY on purpose. It reads and writes Workers KV and
 * dispatches a GitHub workflow; it never touches the backend, because the state
 * this page exists to fix is precisely "the backend is stopped." That's also why
 * it can't live as a tab on `/admin` — that page is built entirely on
 * `/api/admin/*` polls and renders "unavailable" the moment the origin goes away.
 *
 * Gating is inherited, not rebuilt: the prod Access app already covers
 * `hire.<apex>/admin` and everything under it (edge-enforced, before the Worker
 * runs), and the dev host is owner-gated whole. So this route is owner-only with
 * no new gate — see §24.189 D3.
 */
// `admin_.standby` (trailing underscore) is deliberate: it makes `/admin/standby`
// a SIBLING of `/admin`, not a child. `/admin` is a leaf page, and nesting would
// force it to become a layout with an <Outlet/> — which would also mean the
// standby console rendering inside a page built entirely on `/api/admin/*` polls
// that cannot answer while the origin is stopped.
export const Route = createFileRoute('/(ops)/admin_/standby')({
  loader: () => getStandbyView(),
  component: StandbyConsole,
  head: () => {
    const base = seo({
      title: 'Standby — control',
      description: 'Owner-only standby control. Gated; served only behind Cloudflare Access.',
      path: '/admin/standby',
    })
    return { meta: [...base.meta, { name: 'robots', content: 'noindex' }] }
  },
})

interface StandbyPostResult {
  ok?: boolean
  error?: string
  snapshotCaptured?: boolean
  dispatched?: boolean
  dispatchError?: string | null
}

function StandbyConsole() {
  const initial = Route.useLoaderData()
  const router = useRouter()
  const [state, setState] = useState<StandbyState>(initial.state)
  const [snapshot] = useState<StandbySnapshot | null>(initial.snapshot)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [arming, setArming] = useState<'enter' | 'exit' | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onStandby = state.mode === 'standby'

  const post = async (action: 'enter' | 'exit'): Promise<void> => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/admin/standby', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, confirm: true, note: note.trim() || undefined }),
      })
      const body = (await res.json().catch(() => ({}))) as StandbyPostResult
      if (!res.ok) {
        setError(body.error ?? `request failed (${res.status})`)
      } else if (action === 'enter') {
        // Render the outcome of our own write rather than re-reading: KV is
        // eventually consistent (~60s), so an immediate read-back can be stale.
        setState({ ...state, mode: 'standby', vm: 'stopping', since: new Date().toISOString() })
        setResult(
          [
            'Standby is on — the public site is now the standby page.',
            body.snapshotCaptured === false
              ? 'WARNING: the identity snapshot failed, so the standby page will show fewer contact links.'
              : 'Identity snapshot captured.',
            body.dispatched
              ? 'Teardown dispatched: the VM is being halted and stopped.'
              : `Teardown NOT dispatched (${body.dispatchError ?? 'unknown'}) — stop the VM by hand, see below.`,
          ].join(' '),
        )
      } else {
        setState({ ...state, vm: 'starting' })
        setResult(
          'Resume dispatched. The VM is starting; the site stays on the standby page until the workflow confirms it is healthy.',
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error')
    } finally {
      setBusy(false)
      setArming(null)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12 sm:px-6" data-testid="standby-console">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Standby</h1>
          <span className="rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            edge-only
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Pause the job search: stop the VM, take the public site down to a single standby page, and bring it all back
          on one click. This page runs entirely at the Cloudflare edge, so it keeps working when the backend
          doesn&apos;t — that&apos;s the point of it.
        </p>
      </header>

      {/* Current state */}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Current state</h2>
          <span
            data-testid="standby-state-badge"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px]',
              onStandby ? 'border-amber-400/50 text-amber-400' : 'border-border text-primary',
            )}
          >
            <span
              aria-hidden="true"
              className={cn('h-1.5 w-1.5 rounded-full', onStandby ? 'bg-amber-400' : 'bg-primary')}
            />
            {onStandby ? 'standby' : 'live'}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px]">
          <Row label="vm (last reported)" value={state.vm} />
          <Row label="since" value={state.since ?? '—'} />
          <Row label="identity snapshot" value={snapshot?.capturedAt ?? 'none'} />
          <Row label="public note" value={state.note ?? '—'} />
        </dl>
      </section>

      {/* The control */}
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">
          {onStandby ? 'Resume the search' : 'Go on standby'}
        </h2>

        {onStandby ? (
          <p className="text-sm text-muted-foreground">
            Starts the VM, rolls any overdue scheduled work forward to its next occurrence (so a missed morning briefing
            doesn&apos;t fire at 3pm), waits for a health check, and only then puts the live site back. The standby page
            stays up until that check passes.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Snapshots your contact identity, switches the public site to the standby page immediately, halts the
              agent, then stops the VM. Disk, databases and the credential vault are all preserved — this is a stop, not
              a teardown, so resuming needs no re-authentication.
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Optional line shown on the standby page
              </span>
              <input
                type="text"
                value={note}
                data-testid="standby-note-input"
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. I started somewhere great in August."
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {arming ? (
            <>
              <button
                type="button"
                data-testid="standby-confirm"
                disabled={busy}
                onClick={() => post(arming)}
                className={cn(
                  'rounded-md border px-3 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-50',
                  arming === 'enter'
                    ? 'border-amber-400 text-amber-400 hover:bg-amber-400/10'
                    : 'border-primary text-primary hover:bg-primary/10',
                )}
              >
                {busy ? 'Working…' : arming === 'enter' ? 'Confirm — go on standby' : 'Confirm — resume'}
              </button>
              <button
                type="button"
                onClick={() => setArming(null)}
                className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid={onStandby ? 'standby-exit' : 'standby-enter'}
              disabled={busy}
              onClick={() => setArming(onStandby ? 'exit' : 'enter')}
              className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-foreground transition-colors hover:bg-muted/40 disabled:opacity-50"
            >
              {onStandby ? 'Resume the search' : 'Go on standby'}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.invalidate()}
            className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            refresh
          </button>
        </div>

        {result ? (
          <p data-testid="standby-result" className="font-mono text-[11px] leading-relaxed text-primary">
            {result}
          </p>
        ) : null}
        {error ? (
          <p data-testid="standby-error" className="font-mono text-[11px] text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {/* What this does and does not cover — the honest edges. */}
      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">What standby does not cover</h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>
            <strong className="text-foreground">Vendor subscriptions.</strong> Anything billed monthly regardless of use
            — the job-search API plan — keeps billing. Pause or downgrade it in that vendor&apos;s own dashboard; there
            is no API here that can do it for you.
          </li>
          <li>
            <strong className="text-foreground">LLM spend needs no separate switch.</strong> With the VM stopped there
            is no agent, no cron and no public sandbox, so model spend goes to zero on its own.
          </li>
          <li>
            <strong className="text-foreground">The Worker stays deployed.</strong> It serves the standby page and this
            console — that is what makes coming back a button rather than a laptop.
          </li>
          <li>
            <strong className="text-foreground">Manual fallback.</strong> If the workflow dispatch ever fails, run{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              gcloud compute instances start career-pilot-host --zone us-central1-a
            </code>{' '}
            and re-run the resume here to clear the flag.
          </li>
        </ul>
      </section>
    </main>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground" title={value}>
        {value}
      </dd>
    </div>
  )
}
