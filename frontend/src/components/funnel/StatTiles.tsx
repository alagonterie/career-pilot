import { deriveStatTiles, type FunnelApplication } from '~/lib/use-funnel'

/**
 * The four PORTAL §5.4 stat tiles above the board, derived client-side from the
 * funnel rows (no new endpoint). Values carry `data-testid="stat-value"` so the
 * visual baseline can mask the date-windowed numbers (they drift); the labels
 * are stable.
 */
export function StatTiles({ apps }: { apps: FunnelApplication[] }) {
  const tiles = deriveStatTiles(apps)
  return (
    <div data-testid="funnel-stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{t.label}</p>
          <p data-testid="stat-value" className="mt-2 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {t.value}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{t.hint}</p>
        </div>
      ))}
    </div>
  )
}
