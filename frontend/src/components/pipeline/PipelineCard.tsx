import type { PipelineApplication } from '~/lib/use-pipeline'
import { cn } from '~/lib/utils'

/**
 * One application on the pipeline board (PORTAL §5.4). Obfuscated label by
 * default; the real company name + a `◆ public` marker when the reveal tier is
 * set. A `<button>` so it's keyboard-operable and axe-clean. The day-count
 * carries `data-testid="funnel-card-age"` so the visual baseline can mask it
 * (it drifts with wall-clock; the semantic E2E asserts the time-independent
 * stage/label instead).
 */
export function PipelineCard({ app, onSelect }: { app: PipelineApplication; onSelect: () => void }) {
  const isPublic = app.public_state === 'public'
  // The bar shows win_confidence (a low-rigor heuristic) rather than restating
  // the stage the card is already filed under (§24.35 Pass D, #8).
  const win = app.win_confidence
  // §24.65: kit-existence cue in the same glyph register as `◆ public`.
  const kitCount = app.interview_kits?.length ?? 0

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="funnel-card"
      className="w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('truncate font-mono text-sm', isPublic ? 'text-foreground' : 'text-muted-foreground')}>
          {isPublic ? app.application_ref : `[${app.application_ref}]`}
        </span>
        {isPublic ? (
          <span
            data-testid="reveal-marker"
            className="shrink-0 font-mono text-xs text-primary"
            title="revealed with the company's awareness"
          >
            ◆ public
          </span>
        ) : null}
      </div>

      {app.role_title ? <p className="mt-1 truncate text-xs text-muted-foreground">{app.role_title}</p> : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <p data-testid="funnel-card-age" className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {app.days_in_stage != null ? `${app.days_in_stage}d in stage` : '—'}
        </p>
        {kitCount > 0 ? (
          <span
            data-testid="funnel-card-kit"
            className="shrink-0 font-mono text-[10px] text-ai"
            title="AI-built interview kits — open the card for details"
          >
            ▤ {kitCount > 1 ? `${kitCount} kits` : 'kit'}
          </span>
        ) : null}
      </div>

      {win != null ? (
        <div className="mt-2 flex items-center gap-1.5" title="AI-scored win confidence — a low-rigor heuristic">
          <div aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-ai/70" style={{ width: `${Math.max(0, Math.min(100, win))}%` }} />
          </div>
          <span className="font-mono text-[10px] tabular-nums text-ai">~{win}%</span>
        </div>
      ) : null}
    </button>
  )
}
