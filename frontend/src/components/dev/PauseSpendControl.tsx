import * as React from 'react'

import { Badge } from '~/components/ui/badge'
import { Card, CardContent } from '~/components/ui/card'
import { cn } from '~/lib/utils'
import type { KnobWriteResult, PauseState } from '~/lib/use-dev-inspector'

interface PauseSpendControlProps {
  pauseState: PauseState | undefined
  onControl: (action: 'pause' | 'resume') => Promise<KnobWriteResult>
}

/**
 * The dev "Pause LLM spend" control (§24.43e). When the agent is live, one click
 * halts all container spawns + turns the sim off → zero LLM spend, GCP infra
 * untouched; when frozen, one click resumes. Optimistic so it flips instantly;
 * the parent poll reconciles. Reversible only — the killswitch is NOT here (it's
 * Telegram + manual recovery). `killswitch` state shows a read-only note.
 */
export function PauseSpendControl({ pauseState, onControl }: PauseSpendControlProps) {
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [optimistic, setOptimistic] = React.useState<PauseState | null>(null)

  // Once the poll reflects the real state, drop the optimistic override.
  React.useEffect(() => {
    setOptimistic(null)
  }, [pauseState])

  const effective = optimistic ?? pauseState ?? 'active'
  const frozen = effective === 'halted' || effective === 'killswitch'
  const killswitch = effective === 'killswitch'

  const act = React.useCallback(
    async (action: 'pause' | 'resume') => {
      setSaving(true)
      setError(null)
      setOptimistic(action === 'pause' ? 'halted' : 'active')
      const res = await onControl(action)
      setSaving(false)
      if (!res.ok) {
        setOptimistic(null) // revert
        setError(res.error ?? `HTTP ${res.status}`)
      }
    },
    [onControl],
  )

  return (
    <Card data-testid="pause-spend-control" className={cn(frozen ? 'border-primary/60 bg-primary/5' : 'border-border')}>
      <CardContent className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={frozen ? 'default' : 'outline'} data-testid="pause-spend-badge">
              {frozen ? 'spend frozen' : 'spend live'}
            </Badge>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              pause_state: {effective}
            </span>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {frozen
              ? 'No containers can spawn and the sim is off — zero LLM spend. GCP infra is still up.'
              : 'Halts the agent (no spawns) + turns the sim off → stops all LLM spend. Infra stays up; reversible.'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {killswitch ? (
            <span className="font-mono text-[11px] text-destructive">killswitch — recover via SSH (RECOVERY.md)</span>
          ) : frozen ? (
            <button
              type="button"
              data-testid="pause-spend-resume"
              disabled={saving}
              onClick={() => void act('resume')}
              className="rounded-md border border-transparent bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              ▶ Resume spend
            </button>
          ) : (
            <button
              type="button"
              data-testid="pause-spend-pause"
              disabled={saving}
              onClick={() => void act('pause')}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50"
            >
              ⏸ Pause LLM spend
            </button>
          )}
        </div>
      </CardContent>
      {error ? <p className="px-4 pb-3 text-[11px] text-destructive sm:px-6">{error}</p> : null}
    </Card>
  )
}
