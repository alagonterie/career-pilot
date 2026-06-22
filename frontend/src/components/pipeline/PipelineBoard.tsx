import { motion } from 'motion/react'

import { Skeleton } from '~/components/ui/skeleton'
import { PIPELINE_LANE_HEIGHT, PIPELINE_STAGE_SET, PIPELINE_STAGES } from '~/lib/pipeline-stages'
import type { PipelineApplication } from '~/lib/use-pipeline'

import { PipelineCard } from './PipelineCard'

// The board columns are the canonical left→right stages (§24.79 D2 — the single
// source in `~/lib/pipeline-stages`, shared with the compact strips). The board
// renders each stage's `long` name (room for the descriptive label); `bookmarked`
// and the terminal `rejected`/`withdrawn` stages are surfaced in a separate strip
// rather than dropped — nothing in the pipeline is silently hidden.
//
// Naming note (§24.77 D3): the visitor-facing rename to "pipeline" is complete in
// component/hook/type names, but the `data-testid="pipeline-*"` selectors keep the
// old prefix on purpose — they're an internal component↔test contract (the
// Playwright specs + the named `pipeline*.png` visual baselines), so renaming them
// is pure churn for zero visitor benefit. Same retained-internal boundary as the
// `/api/pipeline` fetch URL.

/**
 * The horse-race board (PORTAL §5.4). Each card is a `motion` element keyed by
 * `layoutId`, so when a poll moves an application to a new column the card
 * animates across — the gamified "this person is in demand" motion. The card
 * animation is frozen under prefers-reduced-motion via the root
 * `MotionConfig reducedMotion="user"` (src/routes/__root.tsx — §24.36 36.4),
 * which also keeps the Playwright visual baselines deterministic.
 */
export function PipelineBoard({
  apps,
  onSelect,
}: {
  apps: PipelineApplication[]
  onSelect: (app: PipelineApplication) => void
}) {
  // Newest activity first — a closed/bookmarked archive reads most-recent → oldest
  // (left → right in the filmstrip); fall back to applied_at when last_activity is null.
  const offboard = apps
    .filter((a) => !PIPELINE_STAGE_SET.has(a.stage))
    .sort((a, b) => (b.last_activity_at ?? b.applied_at ?? '').localeCompare(a.last_activity_at ?? a.applied_at ?? ''))

  return (
    <>
      {/* grid-cols-1 at the base is load-bearing (§24.58): a bare `grid` track
          sizes to content min-width, and a truncated long role title still
          contributes its full nowrap line — one real-world title blows the
          phone layout out sideways. grid-cols-N = minmax(0,1fr) = the clamp. */}
      <div data-testid="pipeline-board" className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {PIPELINE_STAGES.map((col) => {
          const items = apps.filter((a) => a.stage === col.stage)
          return (
            <section
              key={col.stage}
              aria-label={col.long}
              data-testid={`pipeline-col-${col.stage}`}
              className="flex flex-col rounded-lg border border-border bg-background/40 p-2"
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  {col.long}
                </h2>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{items.length}</span>
              </header>
              {/* Desktop keeps a scrolling lane (uniform lanes, board stability —
                  §24.35 Pass D) that now scales taller with the viewport (§24.79
                  D3, `PIPELINE_LANE_HEIGHT`). On a phone the board is a vertical
                  stack, so lanes are content-height and an empty stage collapses
                  to just its header row (no full-height void — §13). */}
              <div
                className={
                  items.length === 0
                    ? `hidden flex-col gap-2 sm:flex sm:overflow-y-auto ${PIPELINE_LANE_HEIGHT}`
                    : `flex flex-col gap-2 sm:overflow-y-auto ${PIPELINE_LANE_HEIGHT}`
                }
              >
                {items.map((a) => (
                  <motion.div key={a.application_id} layout layoutId={a.application_id}>
                    <PipelineCard app={a} onSelect={() => onSelect(a)} />
                  </motion.div>
                ))}
                {items.length === 0 ? (
                  <p className="px-1 py-3 text-center font-mono text-xs text-muted-foreground">—</p>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>

      {/* Always rendered (§24.62): the strip popping in/out between loading and
          loaded shifted everything below it. Empty gets an honest line instead
          of disappearing — nothing in the pipeline is silently hidden either way. */}
      <section aria-label="Bookmarked and closed" data-testid="pipeline-offboard" className="mt-4">
        <h2 className="mb-2 font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Bookmarked &amp; closed
        </h2>
        {offboard.length > 0 ? (
          // A single horizontal filmstrip (§24.138 A0-cont, owner call): uniform
          // fixed-width cards in ONE row that scrolls sideways — so the strip stays
          // one card tall and never grows the page down, however many close. pb-1
          // leaves room for the horizontal scrollbar.
          <div data-testid="pipeline-offboard-cards" className="flex gap-2 overflow-x-auto pb-1 opacity-70">
            {offboard.map((a) => (
              <div key={a.application_id} className="w-[14rem] shrink-0">
                <PipelineCard app={a} onSelect={() => onSelect(a)} />
              </div>
            ))}
          </div>
        ) : (
          // min-h = one card row (114px, the measured PipelineCard footprint), so
          // loading→empty holds the same ground as loading→cards (§24.62).
          <div className="flex min-h-[114px] items-center">
            <p data-testid="pipeline-offboard-empty" className="font-mono text-xs text-muted-foreground">
              Nothing bookmarked or closed yet.
            </p>
          </div>
        )}
      </section>
    </>
  )
}

/** The loading-state twin of the board (§24.36 36.1): the same 5-column grid with
 * skeleton cards, so the pipeline keeps its shape (no layout shift) while the poll
 * is in flight. Static markup — no motion, no data. */
export function PipelineBoardSkeleton() {
  return (
    <div data-testid="pipeline-skeleton" className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {PIPELINE_STAGES.map((col, i) => (
        <section
          key={col.stage}
          aria-label={col.long}
          className="flex flex-col rounded-lg border border-border bg-background/40 p-2"
        >
          <header className="mb-2 flex items-center justify-between px-1">
            <h2 className="font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {col.long}
            </h2>
          </header>
          <div className={`flex flex-col gap-2 ${PIPELINE_LANE_HEIGHT}`}>
            {Array.from({ length: ((i * 2) % 3) + 1 }).map((_, j) => (
              <Skeleton key={j} className="h-16 w-full" />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** The loading twin of the always-rendered Bookmarked & closed strip (§24.62):
 * without it the strip pops in under the board on load and shifts everything
 * below. Header + one card-height row, with the skeletons sized to the real
 * PipelineCard footprint (114px measured) so loading→loaded doesn't resize. */
export function PipelineOffboardSkeleton() {
  return (
    <section aria-label="Bookmarked and closed" data-testid="pipeline-offboard-skeleton" className="mt-4">
      <h2 className="mb-2 font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Bookmarked &amp; closed
      </h2>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[114px] w-[14rem] shrink-0" />
        ))}
      </div>
    </section>
  )
}
