import type { ReactNode } from 'react'

import { InfoTip } from '~/components/InfoTip'
import { Skeleton } from '~/components/ui/skeleton'
import type { SystemMode } from '~/lib/use-architecture'

import { STATUS_META, type NodeStatus } from './nodes'

// Fixed chip geometry (the same shell drives the loaded chip AND its loading
// skeleton) so neither a value change (LIVE↔SHADOW, RUNNING↔HALTED) nor
// loading→loaded shifts the header's size or position. Widths fit the widest
// value (SHADOW / RUNNING) with a little slack.
const CHIP = 'flex h-[34px] items-center gap-2 rounded-md border border-border bg-card px-3'
const MODE_W = 'w-[132px]'
const AGENTS_W = 'w-[160px]'

function Chip({
  label,
  value,
  tone,
  info,
  widthClass,
}: {
  label: string
  value: string
  tone: string
  info?: ReactNode
  widthClass: string
}) {
  return (
    <div className={`${CHIP} ${widthClass}`}>
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${tone}`}>{value}</span>
      {info ? (
        <span className="ml-auto">
          <InfoTip label={label}>{info}</InfoTip>
        </span>
      ) : null}
    </div>
  )
}

/** pause_state → an agent-runtime word that says what it MEANS. The raw ladder
 * value "active" under a "Pause" label read as a contradiction ("pause: active");
 * "Agents: RUNNING" is what it actually means. */
const AGENT_STATE: Record<SystemMode['pause_state'], string> = {
  active: 'RUNNING',
  paused: 'PAUSED',
  halted: 'HALTED',
  killswitch: 'KILLED',
}

/**
 * The system-mode banner (§24.28): `live_mode` as a labeled mode (SHADOW/LIVE —
 * a mode, not a health color) and `pause_state` as the agent-runtime state.
 * Each chip carries an InfoTip explaining what the value means (§24.57 — the
 * tap/mobile-capable replacement for the old desktop-only `title` tooltip).
 * Degrades to a neutral "connecting" chip while `mode` is still null.
 */
export function ModeBanner({ mode, loading = false }: { mode: SystemMode | null; loading?: boolean }) {
  if (loading) {
    // The two chip shells at their exact loaded geometry, filled with skeletons —
    // so loading→loaded is a pure content swap, zero layout shift.
    return (
      <div data-testid="arch-mode-banner" className="flex flex-wrap items-center gap-3">
        <div className={`${CHIP} ${MODE_W}`}>
          <Skeleton className="h-3.5 w-full" />
        </div>
        <div className={`${CHIP} ${AGENTS_W}`}>
          <Skeleton className="h-3.5 w-full" />
        </div>
      </div>
    )
  }
  if (!mode) {
    return (
      <div data-testid="arch-mode-banner" className="flex flex-wrap items-center gap-3">
        <Chip label="System" value="connecting…" tone="text-muted-foreground" widthClass={MODE_W} />
      </div>
    )
  }

  const liveTone = mode.live_mode ? 'text-primary' : 'text-muted-foreground'
  const pauseTone =
    mode.pause_state === 'active' ? 'text-primary' : mode.pause_state === 'paused' ? 'text-warn' : 'text-destructive'

  return (
    <div data-testid="arch-mode-banner" className="flex flex-wrap items-center gap-3">
      <Chip
        label="Mode"
        widthClass={MODE_W}
        value={mode.live_mode ? 'LIVE' : 'SHADOW'}
        tone={liveTone}
        info={
          mode.live_mode
            ? 'LIVE — the agents take real, reversible action: drafting outreach in Gmail, writing to the calendar, updating the pipeline. SHADOW would have them observe and draft only.'
            : 'SHADOW — the agents observe and draft, but take no live action (no Gmail drafts, no calendar writes). Flip to LIVE to let them act for real.'
        }
      />
      <Chip
        label="Agents"
        widthClass={AGENTS_W}
        value={AGENT_STATE[mode.pause_state]}
        tone={pauseTone}
        info={
          <>
            The spend kill-switch ladder: <b>RUNNING</b> (agents act normally) → <b>PAUSED</b> (temporarily held) →{' '}
            <b>HALTED</b> (all LLM spend frozen) → <b>KILLED</b>.
            {mode.pause_reason ? <> Reason: {mode.pause_reason}.</> : null}
          </>
        }
      />
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
