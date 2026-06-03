import * as React from 'react'

import {
  SURFACES,
  SURFACE_STATES,
  resetSurfaceStates,
  setSurfaceState,
  useAllSurfaceStates,
  type Surface,
  type SurfaceState,
} from '~/lib/dev-state'
import { cn } from '~/lib/utils'

/**
 * Dev-only async-state switcher (§24.36 / Sub-milestone 36.1). A small fixed
 * corner panel — present whenever the app runs in dev (`pnpm dev:mock`) — that
 * flips each async surface between normal / loading / empty / error live, with
 * no env edits or restarts. The hooks attach the chosen `?__state` to their
 * fetches; the mock-gated API serves the matching state.
 *
 * NEVER in the production bundle: the only mount site
 * (`__root.tsx`) renders it behind `import.meta.env.DEV`, so Rollup tree-shakes
 * it from the prod build. This component also no-ops on the server / pre-mount
 * to keep SSR output empty.
 */
const SHORT: Record<SurfaceState, string> = { normal: 'N', loading: 'L', empty: 'E', error: '⚠' }

export function DevStateSwitcher() {
  const [mounted, setMounted] = React.useState(false)
  const [open, setOpen] = React.useState(true)
  const states = useAllSurfaceStates()

  React.useEffect(() => setMounted(true), [])
  if (!mounted) return null

  const anyForced = SURFACES.some((s) => states[s.id] !== 'normal')

  return (
    <div className="fixed bottom-3 right-3 z-50 font-mono text-[11px] text-foreground">
      {open ? (
        <div className="w-56 rounded-lg border border-border bg-card/95 p-2 shadow-lg backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="uppercase tracking-widest text-muted-foreground">dev · states</span>
            <div className="flex items-center gap-2">
              {anyForced ? (
                <button type="button" onClick={() => resetSurfaceStates()} className="text-accent-cool hover:underline">
                  reset
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Collapse dev state switcher"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
          </div>
          <ul className="flex flex-col gap-1">
            {SURFACES.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{s.label}</span>
                <div className="flex gap-0.5">
                  {SURFACE_STATES.map((st) => (
                    <StateButton key={st} surface={s.id} state={st} active={states[s.id] === st} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'rounded-md border border-border bg-card/95 px-2 py-1 shadow-lg backdrop-blur hover:border-primary',
            anyForced ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          dev · states{anyForced ? ' ●' : ''}
        </button>
      )}
    </div>
  )
}

function StateButton({ surface, state, active }: { surface: Surface; state: SurfaceState; active: boolean }) {
  return (
    <button
      type="button"
      title={state}
      onClick={() => setSurfaceState(surface, state)}
      className={cn(
        'h-5 w-5 rounded border tabular-nums transition-colors',
        active
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {SHORT[state]}
    </button>
  )
}
