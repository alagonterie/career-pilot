import * as React from 'react'

import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { cn } from '~/lib/utils'
import type { DevStateResponse, KnobWriteResult } from '~/lib/use-dev-inspector'

interface SimStatePanelProps {
  state: DevStateResponse | null
  /** When provided, renders a "Sweep & convert now" action (§24.43c). */
  onSweep?: () => Promise<KnobWriteResult>
}

/** Read-only view of the recruiter-sim's live state + the applications it seeded
 * (24.42c). Joins each sim app to its DB row so you see the curator's advance.
 * With `onSweep`, adds a button to convert the sim's inbox to board moves now. */
export function SimStatePanel({ state, onSweep }: SimStatePanelProps) {
  const apps = state?.apps ?? []
  const dbStatusById = new Map((state?.applications ?? []).map((a) => [a.id, a.status]))

  const [sweeping, setSweeping] = React.useState(false)
  const [sweepMsg, setSweepMsg] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const doSweep = React.useCallback(async () => {
    if (!onSweep) return
    setSweeping(true)
    setSweepMsg(null)
    const res = await onSweep()
    setSweeping(false)
    setSweepMsg(
      res.ok
        ? { tone: 'ok', text: 'Sweep enqueued — the orchestrator converts the inbox on its next wake.' }
        : { tone: 'error', text: res.error ?? `HTTP ${res.status}` },
    )
  }, [onSweep])

  return (
    <Card data-testid="sim-state-panel">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">Sim state</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {onSweep ? (
            <button
              type="button"
              data-testid="sweep-now"
              disabled={sweeping}
              onClick={() => void doSweep()}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50"
            >
              ⟳ Sweep &amp; convert now
            </button>
          ) : null}
          <Badge variant={state?.enabled ? 'default' : 'secondary'} data-testid="sim-enabled-badge">
            {state?.enabled ? 'running' : 'idle'}
          </Badge>
          <span className="font-mono text-[10px] text-muted-foreground">
            {apps.length} app{apps.length === 1 ? '' : 's'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {sweepMsg ? (
          <p
            data-testid="sweep-status"
            className={cn('mb-2 text-[11px]', sweepMsg.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive')}
          >
            {sweepMsg.text}
          </p>
        ) : null}
        {apps.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No simulated applications in flight. Flip <code className="font-mono">recruiter_sim_enabled</code> on (dev
            stack) and a few will seed over the next ticks.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Company</th>
                  <th className="py-1.5 pr-3 font-medium">Role</th>
                  <th className="py-1.5 pr-3 font-medium">Label</th>
                  <th className="py-1.5 pr-3 font-medium">Stage</th>
                  <th className="py-1.5 pr-3 font-medium">Next up</th>
                  <th className="py-1.5 pr-3 font-medium">Sim</th>
                  <th className="py-1.5 font-medium">DB status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {apps.map((a) => (
                  <tr key={a.appId} data-testid={`sim-app-${a.appId}`}>
                    <td className="py-1.5 pr-3 font-medium">{a.company}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{a.role}</td>
                    <td className="py-1.5 pr-3 font-mono text-[10px]">{a.obfuscatedLabel}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {a.stageIndex}/{a.totalStages}
                    </td>
                    <td className="py-1.5 pr-3" data-testid={`sim-next-${a.appId}`}>
                      <span className="font-mono text-[10px]">{a.upcoming}</span>
                      {a.status === 'active' ? (
                        <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                          · {relTime(a.nextFireAtMs)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3">
                      <SimStatusChip status={a.status} outcome={a.outcome} />
                    </td>
                    <td className="py-1.5 font-mono text-[10px]">{dbStatusById.get(a.appId) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SimStatusChip({ status, outcome }: { status: string; outcome: string | null }) {
  if (status === 'closed' && outcome) {
    return (
      <Badge variant={outcome === 'offer' ? 'default' : 'destructive'} className="px-1.5 py-0 text-[10px]">
        {outcome}
      </Badge>
    )
  }
  if (status === 'ghosted') {
    return (
      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
        ghosted
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
      {status}
    </Badge>
  )
}

/** A compact relative time ("in 3m" / "2m ago" / "now"). */
function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms === 0) return '—'
  const delta = ms - Date.now()
  const abs = Math.abs(delta)
  const mins = Math.round(abs / 60000)
  if (mins < 1) return 'now'
  const unit = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`
  return delta > 0 ? `in ${unit}` : `${unit} ago`
}
