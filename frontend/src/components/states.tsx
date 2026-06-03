import type { ReactNode } from 'react'

import { cn } from '~/lib/utils'

/**
 * Shared async-state language (§24.36 / Sub-milestone 36.1). Content-shaped
 * surfaces use the `<Skeleton>` primitive for loading; these cover the other two
 * legs — a themed empty/error note, and the stream "connecting…" affordance — so
 * no surface renders a bare-blank or an un-themed spinner.
 */

/** A themed one-line note for empty / error / offline states. `tone="error"`
 * adds a muted status dot; the copy stays calm (no alarm colors). */
export function StateNote({
  children,
  tone = 'muted',
  className,
  ...rest
}: {
  children: ReactNode
  tone?: 'muted' | 'error'
} & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('flex items-center gap-2 font-mono text-sm text-muted-foreground', className)} {...rest}>
      {tone === 'error' ? (
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" />
      ) : null}
      {children}
    </p>
  )
}

/** A blinking terminal cursor — the loading affordance for streams (the trace
 * stream / simulator terminal), where a skeleton can't predict the shape. */
export function LiveCursor({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-block w-[0.5ch] animate-pulse bg-accent-cool/80', className)}>
      &nbsp;
    </span>
  )
}
