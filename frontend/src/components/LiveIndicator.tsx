import type { StreamStatus } from '~/lib/sse'
import { cn } from '~/lib/utils'

/**
 * The ●live indicator (PORTAL §5.1 + §8.3). A single dot driven by the SSE
 * connection state: it pulses (CSS-only, reduced-motion-safe) while live, and
 * degrades gracefully when the stream drops. The visitor's first hint that
 * this is a real, running system.
 */
export function LiveIndicator({ status, count }: { status: StreamStatus | 'idle'; count: number }) {
  const live = status === 'open'
  const label = live ? 'live' : status === 'reconnecting' ? 'reconnecting' : 'connecting'
  return (
    <span
      data-testid="live-indicator"
      data-status={status}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
      title={`${count} event${count === 1 ? '' : 's'} received`}
    >
      <span
        aria-hidden="true"
        className={cn('h-2 w-2 rounded-full', live ? 'bg-primary cp-live-pulse' : 'bg-muted-foreground')}
      />
      {label}
    </span>
  )
}
