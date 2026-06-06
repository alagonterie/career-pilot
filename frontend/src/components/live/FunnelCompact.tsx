import { Skeleton } from '~/components/ui/skeleton'
import type { FunnelApplication } from '~/lib/use-funnel'

// The displayed pipeline, left → right (mirrors the 7.1 FunnelBoard columns).
const STAGES: { stage: string; label: string }[] = [
  { stage: 'applied', label: 'Applied' },
  { stage: 'screening', label: 'Screening' },
  { stage: 'tech', label: 'Tech' },
  { stage: 'final', label: 'Final' },
  { stage: 'offer', label: 'Offer' },
]

/**
 * The compact one-row funnel for /live (PORTAL §5.2) — the designed reuse of the
 * 7.1 funnel data flagged in §24.27. Stage counts as a strip; a public OFFER is
 * revealed by name with the ◆ marker (the reveal tier), everything else stays a
 * count. Pure presentation of the already-polled `/api/funnel` rows.
 *
 * `loading` swaps the per-stage counts for content-shaped skeletons (§24.36 36.1,
 * mirroring `StatTiles`) so the strip keeps its exact shape while the first poll
 * is in flight — the caller can render it from the very first paint instead of
 * popping it into existence once data arrives.
 */
export function FunnelCompact({ apps, loading = false }: { apps: FunnelApplication[]; loading?: boolean }) {
  const counts: Record<string, number> = {}
  for (const a of apps) counts[a.stage] = (counts[a.stage] ?? 0) + 1
  const publicOffers = apps.filter((a) => a.stage === 'offer' && a.public_state === 'public')

  return (
    <div data-testid="funnel-compact" className="flex flex-col gap-3">
      <div className="grid grid-cols-5 gap-1.5">
        {STAGES.map((s) => (
          <div
            key={s.stage}
            data-testid={`funnel-compact-${s.stage}`}
            className="flex flex-col items-center rounded-md border border-border bg-background/40 px-1 py-2"
          >
            {loading ? (
              // h-7 matches the text-lg count's line box → identical cell height.
              <Skeleton className="h-7 w-6" />
            ) : (
              <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {counts[s.stage] ?? 0}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
      {!loading && publicOffers.length > 0 ? (
        <p data-testid="funnel-compact-reveal" className="font-mono text-xs text-primary">
          ◆ {publicOffers.map((a) => a.application_ref).join(', ')} — public offer
        </p>
      ) : null}
    </div>
  )
}
