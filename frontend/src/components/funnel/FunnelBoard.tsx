import { motion } from 'motion/react'

import { Skeleton } from '~/components/ui/skeleton'
import type { FunnelApplication } from '~/lib/use-funnel'

import { FunnelCard } from './FunnelCard'

// The displayed pipeline columns, left → right (PORTAL §5.4). `bookmarked` and
// the terminal `rejected`/`withdrawn` stages are surfaced in a separate strip
// rather than dropped — nothing in the funnel is silently hidden.
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
export function FunnelBoard({
  apps,
  onSelect,
}: {
  apps: FunnelApplication[]
  onSelect: (app: FunnelApplication) => void
}) {
  const offboard = apps.filter((a) => !PIPELINE_STAGES.has(a.stage))

  return (
    <>
      <div data-testid="funnel-board" className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
                    <FunnelCard app={a} onSelect={() => onSelect(a)} />
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

      {offboard.length > 0 ? (
        <section aria-label="Bookmarked and closed" data-testid="funnel-offboard" className="mt-4">
          <h2 className="mb-2 font-mono text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Bookmarked &amp; closed
          </h2>
          <div className="flex flex-wrap gap-2 opacity-70">
            {offboard.map((a) => (
              <div key={a.application_id} className="min-w-[10rem] flex-1 sm:max-w-[14rem]">
                <FunnelCard app={a} onSelect={() => onSelect(a)} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  )
}

/** The loading-state twin of the board (§24.36 36.1): the same 5-column grid with
 * skeleton cards, so the funnel keeps its shape (no layout shift) while the poll
 * is in flight. Static markup — no motion, no data. */
export function FunnelBoardSkeleton() {
  return (
    <div data-testid="funnel-skeleton" className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
