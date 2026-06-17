import { Link } from '@tanstack/react-router'
import { motion } from 'motion/react'
import * as React from 'react'

import { AgentMark } from '~/components/AgentMark'
import { InfoTip } from '~/components/InfoTip'
import { useDialog } from '~/lib/use-dialog'
import type { PipelineApplication } from '~/lib/use-pipeline'
import { kitDate, roundLabel } from '~/lib/use-kit'

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
 * §24.27). An accessible modal dialog via the shared `useDialog` contract
 * (PORTAL §8.5): labeled, focus-trapped, Escape + backdrop close, focus
 * restored to the trigger card on close, the rest of the page held inert.
 */
export function DetailPanel({ app, onClose }: { app: PipelineApplication | null; onClose: () => void }) {
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  useDialog(app != null, onClose, panelRef, overlayRef)

  if (!app) return null

  const isPublic = app.public_state === 'public'
  const title = isPublic ? app.application_ref : `[${app.application_ref}]`
  const win = app.win_confidence

  return (
    <div ref={overlayRef} className="fixed inset-0 z-30 flex justify-end">
      {/* touch-action-none: the backdrop must not become a scroll surface on
          touch (§24.58 — useDialog locks the body; this covers the overlay). */}
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 touch-none bg-background/70 backdrop-blur-sm"
      />
      {/* The drawer slides in from its edge (§24.58 — its §8.5 identity made
          visible; before this it popped instantly, which on a phone mid-
          viewport-jump read as "zoomed in"). Reduced-motion users get no slide
          via the root MotionConfig; visual snapshots disable animations. */}
      <motion.aside
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="funnel-detail-title"
        data-testid="funnel-detail"
        className="relative z-10 flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto overscroll-contain border-l border-border bg-card p-6 shadow-xl focus:outline-none"
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

        {/* This application's rows filtered out of the live trace window (§24.60)
            — the honest version of a "related artifacts" view. The reverse of the
            trace-line [ref] links, so /pipeline ↔ /live cross-navigate per app. */}
        <Link
          to="/dashboard"
          search={{ app: app.application_ref }}
          data-testid="detail-live-link"
          className="self-start font-mono text-xs text-accent-cool hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Live activity →
        </Link>

        {/* §24.65: interview kits prepared for this application — all rounds,
            incl. archived (a closed process keeps its prep story). Each row
            links into the /kit dossier; content there is policy-gated
            server-side (sealed while the process is live, full on reveal). */}
        {app.interview_kits && app.interview_kits.length > 0 ? (
          <section aria-labelledby="kits-heading" data-testid="detail-kits" className="flex flex-col gap-2">
            <h3
              id="kits-heading"
              className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
            >
              Interview prep
              <InfoTip label="interview prep">
                The moment an application enters an interview round, the agent builds a two-part mock-interview kit — an
                interviewer manual for a voice-mock Claude plus a phone cheat-sheet — as a private Google Doc. Sections
                that would identify the company stay sealed while the process is live; revealed applications show their
                kits in full.
              </InfoTip>
            </h3>
            <ul className="flex flex-col gap-1.5">
              {app.interview_kits.map((kit) => (
                <li key={kit.round}>
                  <Link
                    to="/kit"
                    search={{ app: app.application_ref, round: kit.round }}
                    data-testid="detail-kit-link"
                    className="flex items-baseline justify-between gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 truncate font-mono text-xs text-foreground">
                      <span aria-hidden="true" className="text-ai">
                        ▤
                      </span>{' '}
                      {roundLabel(kit.round)}
                      {kit.interview_at ? (
                        <span className="ml-2 text-muted-foreground">{kitDate(kit.interview_at)}</span>
                      ) : null}
                      {kit.status === 'archived' ? (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                          archived
                        </span>
                      ) : null}
                    </span>
                    <span aria-hidden="true" className="shrink-0 font-mono text-xs text-accent-cool">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {win != null ? (
          <section aria-labelledby="win-heading" className="flex flex-col gap-2">
            {/* §24.73: no metric InfoTip here — the AgentMark below names the
                scorer and its popover carries the "heuristic, not a promise"
                framing, so a second tip would be redundant. */}
            <h3 id="win-heading" className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Win confidence
            </h3>
            <div className="flex items-center gap-3">
              <div aria-hidden="true" className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-ai" style={{ width: `${Math.max(0, Math.min(100, win))}%` }} />
              </div>
              <span className="font-mono text-sm tabular-nums text-foreground">{win}%</span>
            </div>
            {app.win_confidence_rationale ? (
              <p data-testid="win-rationale" className="text-sm leading-relaxed text-foreground/90">
                {app.win_confidence_rationale}
              </p>
            ) : null}
            <AgentMark actor="win-confidence-scorer" lead="Scored by" />
          </section>
        ) : null}

        {app.published_learning ? (
          <section aria-labelledby="learning-heading" className="flex flex-col gap-2">
            <h3 id="learning-heading" className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Published note
            </h3>
            <p className="text-sm leading-relaxed text-foreground/90">{app.published_learning}</p>
            <AgentMark actor="pipeline-scribe" lead="Published by" />
          </section>
        ) : null}

        <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
          Companies are obfuscated by default; revealed only post-close with the company&apos;s awareness.
        </p>
      </motion.aside>
    </div>
  )
}
