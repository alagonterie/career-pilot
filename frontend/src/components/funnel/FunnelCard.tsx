import type { FunnelApplication } from '~/lib/use-funnel'
import { cn } from '~/lib/utils'

const STAGE_ORDER = ['applied', 'screening', 'tech', 'final', 'offer']

/**
 * One application on the funnel board (PORTAL §5.4). Obfuscated label by
 * default; the real company name + a `◆ public` marker when the reveal tier is
 * set. A `<button>` so it's keyboard-operable and axe-clean. The day-count
 * carries `data-testid="funnel-card-age"` so the visual baseline can mask it
 * (it drifts with wall-clock; the semantic E2E asserts the time-independent
 * stage/label instead).
 */
export function FunnelCard({ app, onSelect }: { app: FunnelApplication; onSelect: () => void }) {
  const isPublic = app.public_state === 'public'
  const stageIdx = STAGE_ORDER.indexOf(app.stage)
  const progress = stageIdx >= 0 ? Math.round(((stageIdx + 1) / STAGE_ORDER.length) * 100) : 0

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

      <p data-testid="funnel-card-age" className="mt-2 font-mono text-[11px] tabular-nums text-muted-foreground">
        {app.days_in_stage != null ? `${app.days_in_stage}d in stage` : '—'}
      </p>

      <div aria-hidden="true" className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
      </div>
    </button>
  )
}
