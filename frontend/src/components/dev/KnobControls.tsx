import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { DevKnob, KnobGroup, KnobWriteResult } from '~/lib/use-dev-inspector'

import { KnobControl } from './KnobControl'

const GROUP_ORDER: KnobGroup[] = ['sim', 'pacing', 'budget', 'models', 'polling']

const GROUP_META: Record<KnobGroup, { title: string; blurb: string }> = {
  sim: { title: 'Recruiter sim', blurb: 'The dev fixture that injects ATS mail into the dev mailbox.' },
  pacing: { title: 'Loop pacing', blurb: 'Cron cadence for the proactive flows. Changes apply on the next reclone.' },
  budget: { title: 'Cost caps', blurb: 'Daily LLM spend ceilings for the dev stack.' },
  models: {
    title: 'Model tier',
    blurb:
      'Drop the orchestrator + subagents off Opus for cheap dev runs (applies on the next spawn). The cost delta shows up in Portkey.',
  },
  polling: { title: 'Polling', blurb: 'How often the host syncs Gmail / Calendar.' },
}

interface KnobControlsProps {
  knobs: DevKnob[]
  onWrite: (key: string, value: boolean | number | string) => Promise<KnobWriteResult>
  onReset: (key: string) => Promise<KnobWriteResult>
  onResetAll: () => Promise<KnobWriteResult>
}

/** The grouped knob control surface (24.42c). Light-control only — the backend
 * allow-lists every key, so an unknown write can't slip through here. */
export function KnobControls({ knobs, onWrite, onReset, onResetAll }: KnobControlsProps) {
  const byGroup = new Map<KnobGroup, DevKnob[]>()
  for (const knob of knobs) {
    const list = byGroup.get(knob.group) ?? []
    list.push(knob)
    byGroup.set(knob.group, list)
  }
  const anyOverridden = knobs.some((k) => k.overridden)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {anyOverridden ? 'Some knobs are overridden (↺ to reset individually).' : 'All knobs are at their defaults.'}
        </p>
        <button
          type="button"
          onClick={() => void onResetAll()}
          disabled={!anyOverridden}
          data-testid="reset-all"
          className="shrink-0 self-start rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:self-auto"
        >
          ↺ All to defaults
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {GROUP_ORDER.filter((g) => byGroup.has(g)).map((group) => {
          const meta = GROUP_META[group]
          return (
            <Card key={group} data-testid={`knob-group-${group}`}>
              <CardHeader className="px-4 pb-2 sm:px-6">
                <CardTitle className="text-base">{meta.title}</CardTitle>
                <p className="text-xs text-muted-foreground">{meta.blurb}</p>
              </CardHeader>
              <CardContent className="divide-y divide-border/60 px-4 pt-0 sm:px-6">
                {(byGroup.get(group) ?? []).map((knob) => (
                  <KnobControl key={knob.key} knob={knob} onWrite={onWrite} onReset={onReset} />
                ))}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
