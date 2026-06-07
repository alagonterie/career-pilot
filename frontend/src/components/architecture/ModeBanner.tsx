import type { SystemMode } from '~/lib/use-architecture'

import { STATUS_META, type NodeStatus } from './nodes'

function Chip({ label, value, tone, title }: { label: string; value: string; tone: string; title?: string }) {
  return (
    <div title={title} className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${tone}`}>{value}</span>
    </div>
  )
}

/**
 * The system-mode banner (§24.28): `live_mode` as a labeled mode (SHADOW/LIVE —
 * a mode, not a health color) and `pause_state` surfaced prominently (a
 * paused/halted system is the most important thing to show). Degrades to a
 * neutral "connecting" chip while `mode` is still null.
 *
 * `compact` (the /live `SystemStatusPanel`, §24.36): the variable-height
 * explainers (the shadow note + a pause `reason:` line) move to the chips'
 * tooltips instead of wrapping inline, so the banner's height is
 * mode-independent and the panel doesn't outgrow its equalized grid row when the
 * system is in SHADOW. The roomy `/architecture` header keeps them inline.
 */
export function ModeBanner({ mode, compact = false }: { mode: SystemMode | null; compact?: boolean }) {
  if (!mode) {
    return (
      <div data-testid="arch-mode-banner" className="flex flex-wrap items-center gap-3">
        <Chip label="System" value="connecting…" tone="text-muted-foreground" />
      </div>
    )
  }

  const liveTone = mode.live_mode ? 'text-primary' : 'text-muted-foreground'
  const pauseTone =
    mode.pause_state === 'active' ? 'text-primary' : mode.pause_state === 'paused' ? 'text-warn' : 'text-destructive'
  const shadowNote = mode.live_mode ? undefined : 'Shadow mode — agents observe and draft, but take no live action.'
  const reasonNote = mode.pause_reason ? `reason: ${mode.pause_reason}` : undefined

  return (
    <div data-testid="arch-mode-banner" className="flex flex-wrap items-center gap-3">
      <Chip
        label="Mode"
        value={mode.live_mode ? 'LIVE' : 'SHADOW'}
        tone={liveTone}
        title={compact ? shadowNote : undefined}
      />
      <Chip
        label="Pause"
        value={mode.pause_state.toUpperCase()}
        tone={pauseTone}
        title={compact ? reasonNote : undefined}
      />
      {!compact && reasonNote ? <span className="font-mono text-xs text-muted-foreground">{reasonNote}</span> : null}
      {!compact && shadowNote ? <span className="text-xs text-muted-foreground">{shadowNote}</span> : null}
    </div>
  )
}

const LEGEND_DOTS: { status: Exclude<NodeStatus, 'structural'>; bg: string }[] = [
  { status: 'healthy', bg: 'bg-primary' },
  { status: 'degraded', bg: 'bg-warn' },
  { status: 'down', bg: 'bg-destructive' },
  { status: 'idle', bg: 'bg-muted-foreground' },
]

/** The honesty legend: live-probed status colors vs structural (no probe). */
export function Legend() {
  return (
    <div
      data-testid="arch-legend"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted-foreground"
    >
      <span className="font-mono uppercase tracking-widest">Live-probed:</span>
      {LEGEND_DOTS.map((d) => (
        <span key={d.status} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${d.bg}`} aria-hidden="true" />
          {STATUS_META[d.status].label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="font-mono">
          ◇
        </span>
        Structural — no live probe
      </span>
    </div>
  )
}
