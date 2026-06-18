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
  // §24.117: published-lesson cue — the ▤-kit's sibling (a ✎ pencil, §24.118 Δ),
  // so the board signals "this application has lessons" the way it does kits.
  const lessonCount = app.learnings?.length ?? 0

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
        {/* §24.117 Δ2: COMPACT chips — glyph + count only (the noun lives in the
            title), so `age + chips` always fits one line and every card keeps the
            same height. The full-word form overflowed narrow cards (both kit +
            lessons present), wrapping the age mid-phrase. */}
        {kitCount > 0 || lessonCount > 0 ? (
          <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-ai">
            {kitCount > 0 ? (
              <span
                data-testid="funnel-card-kit"
                title={`${kitCount} AI-built interview ${kitCount === 1 ? 'kit' : 'kits'} — open the card for details`}
              >
                ▤{kitCount > 1 ? ` ${kitCount}` : ''}
              </span>
            ) : null}
            {lessonCount > 0 ? (
              <span
                data-testid="funnel-card-lesson"
                title={`${lessonCount} published ${lessonCount === 1 ? 'lesson' : 'lessons'} — open the card for details`}
              >
                ✎{lessonCount > 1 ? ` ${lessonCount}` : ''}
              </span>
            ) : null}
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
