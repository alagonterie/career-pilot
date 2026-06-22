import * as React from 'react'

import { Skeleton } from '~/components/ui/skeleton'
import { PIPELINE_STAGES } from '~/lib/pipeline-stages'
import type { PipelineApplication } from '~/lib/use-pipeline'
import { cn } from '~/lib/utils'

/**
 * The compact one-row pipeline for the /dashboard rail + the marketing-home strip
 * (PORTAL §5.2) — the designed reuse of the 7.1 pipeline data flagged in §24.27.
 * Stage counts as a strip; a public OFFER is revealed by name with the ◆ marker
 * (the reveal tier), everything else stays a count. Because this strip *links to*
 * the full board, it renders the short stage codes (§24.79 D2 — APP/SCREEN/…)
 * from the shared `~/lib/pipeline-stages` source the board uses for its long
 * names. Pure presentation of the already-polled `/api/pipeline` rows.
 *
 * §24.119 turned the five flat boxes into a *directional pipeline* — flavor with
 * zero new numbers (the hero stat line already carries the active total, so any
 * count-summary here would just restate it):
 *  - chevrons (`›`) flow the eye left→right toward OFFER; the ones up to the
 *    leading edge brighten ("flow has reached here"), the rest fade;
 *  - OFFER (the goal) takes a quiet brand accent so the finish line is legible;
 *  - the furthest-right populated stage takes a faint ring — a "how far along"
 *    momentum cue (a new *dimension*, not a restated count);
 *  - empty (0-count) stages dim so the eye follows where the pipeline actually is.
 *
 * `expandLabels` (§24.87) opts a wide caller into the LONG stage names at `lg+`
 * (short below) — the home `/` strip sets it (it has the room and reads better);
 * the narrower /dashboard rail leaves it off (the long names don't fit its column).
 *
 * `loading` swaps the per-stage counts for content-shaped skeletons (§24.36 36.1,
 * mirroring `StatTiles`) so the strip keeps its exact shape while the first poll
 * is in flight — the caller can render it from the very first paint instead of
 * popping it into existence once data arrives.
 */
export function PipelineCompact({
  apps,
  loading = false,
  expandLabels = false,
}: {
  apps: PipelineApplication[]
  loading?: boolean
  expandLabels?: boolean
}) {
  const counts: Record<string, number> = {}
  for (const a of apps) counts[a.stage] = (counts[a.stage] ?? 0) + 1
  const publicOffers = apps.filter((a) => a.stage === 'offer' && a.public_state === 'public')

  // §24.119: the leading edge — the furthest-right stage that holds any
  // application. The momentum cue (how far the search has actually reached),
  // NOT a restated number, so it never duplicates the hero stat line. -1 while
  // loading / empty (no ring, all chevrons faded).
  let leadingEdgeIdx = -1
  if (!loading) {
    PIPELINE_STAGES.forEach((s, i) => {
      if ((counts[s.stage] ?? 0) > 0) leadingEdgeIdx = i
    })
  }
  const lastIdx = PIPELINE_STAGES.length - 1

  return (
    <div data-testid="pipeline-compact" className="flex flex-col gap-3">
      <div className="flex items-stretch gap-1">
        {PIPELINE_STAGES.map((s, i) => {
          const n = counts[s.stage] ?? 0
          const isOffer = i === lastIdx
          const isEmpty = !loading && n === 0
          const isLeadingEdge = i === leadingEdgeIdx
          // Chevrons up to (and into) the leading edge read "flow reached here";
          // beyond it they fade — the rail itself shows momentum.
          const chevronReached = i <= leadingEdgeIdx
          return (
            <React.Fragment key={s.stage}>
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex shrink-0 items-center font-mono text-xs',
                    chevronReached ? 'text-primary/50' : 'text-muted-foreground/25',
                  )}
                >
                  ›
                </span>
              ) : null}
              <div
                data-testid={`pipeline-compact-${s.stage}`}
                data-leading-edge={isLeadingEdge ? 'true' : undefined}
                title={
                  isLeadingEdge ? 'the furthest stage an application has reached' : isOffer ? 'the goal' : undefined
                }
                className={cn(
                  'flex flex-1 flex-col items-center rounded-md border px-1 py-2 transition-colors',
                  isOffer ? 'border-primary/30 bg-primary/5' : 'border-border bg-background/40',
                  isLeadingEdge ? 'ring-1 ring-primary/40' : '',
                  isEmpty ? 'opacity-50' : '',
                )}
              >
                {loading ? (
                  // h-7 matches the text-lg count's line box → identical cell height.
                  <Skeleton className="h-7 w-6" />
                ) : (
                  <span
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      isOffer ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {n}
                  </span>
                )}
                <span
                  className={cn(
                    'font-mono text-[10px] uppercase tracking-wider',
                    isOffer ? 'text-primary/80' : 'text-muted-foreground',
                  )}
                >
                  {expandLabels ? (
                    <>
                      <span className="lg:hidden">{s.short}</span>
                      <span className="hidden whitespace-nowrap lg:inline">{s.long}</span>
                    </>
                  ) : (
                    s.short
                  )}
                </span>
              </div>
            </React.Fragment>
          )
        })}
      </div>
      {!loading && publicOffers.length > 0 ? (
        <p data-testid="pipeline-compact-reveal" className="font-mono text-xs text-primary">
          ◆ {publicOffers.map((a) => a.application_ref).join(', ')} — public offer
        </p>
      ) : null}
    </div>
  )
}
