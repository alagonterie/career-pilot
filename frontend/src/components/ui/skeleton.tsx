import type { ComponentProps } from 'react'

import { cn } from '~/lib/utils'

/**
 * The shared skeleton primitive (§24.36 / Sub-milestone 36.1). A pulsing,
 * content-shaped placeholder for async surfaces whose layout is predictable
 * (pipeline cards, ops panels, the stat tiles). Streams (the trace stream, the
 * simulator terminal) deliberately use a "connecting…" affordance instead — a
 * skeleton can't predict an indeterminate stream's shape (the modern split).
 *
 * `aria-hidden` so screen readers skip the decorative shimmer; the surface's
 * own status copy carries the meaning.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}
