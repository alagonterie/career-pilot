import * as React from 'react'

import type { FunnelApplication } from '~/lib/use-funnel'

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

/**
 * The card side-panel (PORTAL §5.4 click-through). Renders from the
 * `/api/funnel` fields available today — the anonymized state/role/stage facts,
 * the win-confidence heuristic, and the published learning when present. The
 * richer per-application timeline + curator narrative are deferred (STRATEGY
 * §24.27). An accessible dialog: labeled, Escape-to-close, the backdrop closes.
 */
export function DetailPanel({ app, onClose }: { app: FunnelApplication | null; onClose: () => void }) {
  const panelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!app) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [app, onClose])

  if (!app) return null

  const isPublic = app.public_state === 'public'
  const title = isPublic ? app.application_ref : `[${app.application_ref}]`
  const win = app.win_confidence

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="funnel-detail-title"
        data-testid="funnel-detail"
        className="relative z-10 flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto border-l border-border bg-card p-6 shadow-xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="funnel-detail-title" className="truncate font-mono text-lg font-semibold text-foreground">
              {title}
            </h2>
            {app.role_title ? <p className="mt-1 text-sm text-muted-foreground">{app.role_title}</p> : null}
            {isPublic ? <p className="mt-1 font-mono text-xs text-primary">◆ public</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 rounded-md border border-border px-2 py-1 font-mono text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Esc
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-4">
          <Fact label="Stage" value={app.stage} />
          <Fact label="Status" value={app.status} />
          <Fact label="Days in stage" value={app.days_in_stage != null ? `${app.days_in_stage}` : '—'} />
          <Fact label="Days in pipeline" value={app.days_in_pipeline != null ? `${app.days_in_pipeline}` : '—'} />
        </dl>

        {win != null ? (
          <section aria-labelledby="win-heading" className="flex flex-col gap-2">
            <h3 id="win-heading" className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Win confidence
            </h3>
            <div className="flex items-center gap-3">
              <div aria-hidden="true" className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, win))}%` }} />
              </div>
              <span className="font-mono text-sm tabular-nums text-foreground">{win}%</span>
            </div>
            <p className="text-[11px] text-muted-foreground">A low-rigor heuristic — not a promise.</p>
          </section>
        ) : null}

        {app.published_learning ? (
          <section aria-labelledby="learning-heading" className="flex flex-col gap-2">
            <h3 id="learning-heading" className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Published note
            </h3>
            <p className="text-sm leading-relaxed text-foreground/90">{app.published_learning}</p>
          </section>
        ) : null}

        <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
          Companies are obfuscated by default; revealed only post-close with the company&apos;s awareness.
        </p>
      </aside>
    </div>
  )
}
