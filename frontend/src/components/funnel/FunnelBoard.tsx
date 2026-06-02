import { MotionConfig, motion } from 'motion/react'

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
 * animates across — the gamified "this person is in demand" motion. Wrapped in
 * `MotionConfig reducedMotion="user"` so the animation is frozen under
 * prefers-reduced-motion (the Playwright visual baselines + reduced-motion
 * users) — deterministic, never a barrier.
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
    <MotionConfig reducedMotion="user">
      <div data-testid="funnel-board" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
              <div className="flex flex-col gap-2">
                {items.map((a) => (
                  <motion.div key={a.application_ref} layout layoutId={a.application_ref}>
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
              <div key={a.application_ref} className="min-w-[10rem] flex-1 sm:max-w-[14rem]">
                <FunnelCard app={a} onSelect={() => onSelect(a)} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </MotionConfig>
  )
}
