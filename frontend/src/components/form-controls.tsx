import * as React from 'react'

import { cn } from '~/lib/utils'

/**
 * A labeled form field whose validation-error line is ALWAYS reserved (§24.120 Δ).
 * The error `<span>` is rendered unconditionally with a one-line min-height, so a
 * message appearing (e.g. hitting Send on an empty form) or clearing never shifts
 * the fields below it — a layout-stability bug that hit every form that copied the
 * old conditional-error `Field`. Shared by the /contact + /watch forms.
 */
export function FormField({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      <span className="min-h-4 text-xs text-destructive">{error}</span>
    </label>
  )
}

/**
 * Stacks every possible label of a control in one grid cell so its width is fixed
 * to the WIDEST label — the visible one overlays, the rest are invisible spacers.
 * A submit button wrapping this never resizes when its label swaps ("Send →" ↔
 * "Sending…", "Watch me apply →" ↔ "Starting…"), with no magic pixel width to
 * guess (§24.120 Δ). Only the active label is in the accessible name (the spacers
 * are `aria-hidden`).
 */
export function StableLabel({ labels, active }: { labels: readonly string[]; active: string }) {
  return (
    <span className="grid">
      {labels.map((label) => (
        <span
          key={label}
          aria-hidden={label !== active}
          className={cn('col-start-1 row-start-1 text-center', label === active ? '' : 'invisible')}
        >
          {label}
        </span>
      ))}
    </span>
  )
}
