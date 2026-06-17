import { motion } from 'motion/react'

import { Skeleton } from '~/components/ui/skeleton'
import type { PipelineApplication } from '~/lib/use-pipeline'

import { PipelineCard } from './PipelineCard'

// The displayed pipeline columns, left → right (PORTAL §5.4). `bookmarked` and
// the terminal `rejected`/`withdrawn` stages are surfaced in a separate strip
// rather than dropped — nothing in the pipeline is silently hidden.
//
// Naming note (§24.77 D3): the visitor-facing rename to "pipeline" is complete in
// component/hook/type names, but the `data-testid="funnel-*"` selectors keep the
// old prefix on purpose — they're an internal component↔test contract (the
// Playwright specs + the named `funnel*.png` visual baselines), so renaming them
// is pure churn for zero visitor benefit. Same retained-internal boundary as the
// `/api/funnel` fetch URL.
const COLUMNS: { stage: string; title: string }[] = [
  { stage: 'applied', title: 'Applied' },
  { stage: 'screening', title: 'Screening' },
  { stage: 'tech', title: 'Tech' },
  { stage: 'final', title: 'Final' },
  { stage: 'offer', title: 'Offer' },
]
const PIPELINE_STAGES = new Set(COLUMNS.map((c) => c.stage))

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
  const offboard = apps.filter((a) => !PIPELINE_STAGES.has(a.stage))

  return (
    <>
      {/* grid-cols-1 at the base is load-bearing (§24.58): a bare `grid` track
          sizes to content min-width, and a truncated long role title still
          contributes its full nowrap line — one real-world title blows the
          phone layout out sideways. grid-cols-N = minmax(0,1fr) = the clamp. */}
      <div data-testid="funnel-board" className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = apps.filter((a) => a.stage === col.stage)
          return (
            <section
              key={col.stage}
              aria-label={col.title}
              data-testid={`funnel-col-${col.stage}`}
              className="flex flex-col rounded-lg border border-border bg-background/40 p-2"
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  {col.title}
                </h2>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{items.length}</span>
              </header>
              {/* Desktop keeps a fixed-height scrolling lane (uniform lanes, board
                  stability — §24.35 Pass D). On a phone the board is a vertical
                  stack, so lanes are content-height and an empty stage collapses
                  to just its header row (no full-height void — §13). */}
              <div
                className={
                  items.length === 0
                    ? 'hidden flex-col gap-2 sm:flex sm:h-[16rem] sm:overflow-y-auto'
                    : 'flex flex-col gap-2 sm:h-[16rem] sm:overflow-y-auto'
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
      <section aria-label="Bookmarked and closed" data-testid="funnel-offboard" className="mt-4">
        <h2 className="mb-2 font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Bookmarked &amp; closed
        </h2>
        {offboard.length > 0 ? (
          <div className="flex flex-wrap gap-2 opacity-70">
            {offboard.map((a) => (
              <div key={a.application_id} className="min-w-[10rem] flex-1 sm:max-w-[14rem]">
                <PipelineCard app={a} onSelect={() => onSelect(a)} />
              </div>
            ))}
          </div>
        ) : (
          // min-h = one card row (114px, the measured PipelineCard footprint), so
          // loading→empty holds the same ground as loading→cards (§24.62).
          <div className="flex min-h-[114px] items-center">
            <p data-testid="funnel-offboard-empty" className="font-mono text-xs text-muted-foreground">
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
    <div data-testid="funnel-skeleton" className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {COLUMNS.map((col, i) => (
        <section
          key={col.stage}
          aria-label={col.title}
          className="flex flex-col rounded-lg border border-border bg-background/40 p-2"
        >
          <header className="mb-2 flex items-center justify-between px-1">
            <h2 className="font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {col.title}
            </h2>
          </header>
          <div className="flex flex-col gap-2 sm:h-[16rem]">
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
    <section aria-label="Bookmarked and closed" data-testid="funnel-offboard-skeleton" className="mt-4">
      <h2 className="mb-2 font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Bookmarked &amp; closed
      </h2>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[114px] min-w-[10rem] flex-1 sm:max-w-[14rem]" />
        ))}
      </div>
    </section>
  )
}
