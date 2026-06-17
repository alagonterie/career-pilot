import { InfoTip } from '~/components/InfoTip'
import { Skeleton } from '~/components/ui/skeleton'
import { deriveStatTiles, type PipelineApplication } from '~/lib/use-pipeline'

/**
 * The four PORTAL §5.4 stat tiles above the board, derived client-side from the
 * pipeline rows (no new endpoint). Values carry `data-testid="stat-value"` so the
 * visual baseline can mask the date-windowed numbers (they drift); the labels
 * are stable. `loading` swaps the values for skeletons (§24.36 36.1) so the row
 * keeps its shape while the pipeline poll is in flight. Each label carries an
 * InfoTip with the tile's honest derivation (§24.60) — the copy lives with the
 * math in `deriveStatTiles`.
 */
export function StatTiles({ apps, loading = false }: { apps: PipelineApplication[]; loading?: boolean }) {
  const tiles = deriveStatTiles(apps)
  return (
    <div data-testid="funnel-stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-4">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            <span className="min-w-0 truncate">{t.label}</span>
            <InfoTip label={t.label}>{t.tip}</InfoTip>
          </p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-12" />
          ) : (
            <p data-testid="stat-value" className="mt-2 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {t.value}
            </p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">{t.hint}</p>
        </div>
      ))}
    </div>
  )
}
