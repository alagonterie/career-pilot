import type { StreamStatus } from '~/lib/sse'
import { cn } from '~/lib/utils'

/**
 * The "Open to offers" availability pill (PORTAL §5.1) — the on-brand signal a
 * recruiter actually wants, with the brand-green dot pulsing while the live
 * activity feed is connected (the page's own liveness) and falling still if it
 * drops. Shared by the home hero (`data-testid="hero-status"`) and the /contact
 * destination (§24.120) so the conversion sink breathes like the rest of the site.
 *
 * Render is byte-identical to the home hero's prior inline pill (same classes,
 * dot logic, and the caller-supplied `title`), so extracting it moved no pixels.
 */
export function AvailabilityBadge({
  status,
  title,
  'data-testid': testId,
}: {
  status: StreamStatus | 'idle'
  /** Tooltip text (the home hero passes its live event count; contact a simpler line). */
  title?: string
  'data-testid'?: string
}) {
  const live = status === 'open'
  return (
    <span
      data-testid={testId}
      data-status={status}
      title={title ?? (live ? 'live' : status)}
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3.5 py-1.5 text-sm text-foreground"
    >
      <span
        aria-hidden="true"
        className={cn('h-2 w-2 rounded-full', live ? 'bg-primary cp-live-pulse' : 'bg-muted-foreground')}
      />
      Open to offers
    </span>
  )
}
