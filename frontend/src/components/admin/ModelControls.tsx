import { KnobControl } from '~/components/dev/KnobControl'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { DevKnob, KnobWriteResult } from '~/lib/use-dev-inspector'

interface ModelControlsProps {
  /** The `models`-group knobs (orchestrators, per-subagent, host-side calls). */
  knobs: DevKnob[]
  onWrite: (key: string, value: boolean | number | string) => Promise<KnobWriteResult>
  onReset: (key: string) => Promise<KnobWriteResult>
}

// The §24.163 Models tab splits the flat `models` group into three labelled
// sections by key-prefix. `host` is the catch-all and MUST stay last.
const SECTIONS = [
  {
    id: 'owner',
    title: 'Owner agent',
    blurb:
      'The agent the candidate talks to — its orchestrator + each subagent. `inherit` = the orchestrator’s model. Applies on the owner’s next container spawn.',
    match: (key: string) => key.startsWith('owner_'),
  },
  {
    id: 'sandbox',
    title: 'Public sandbox',
    blurb:
      'The "Watch it work" simulator — its orchestrator + each subagent. The only visitor-facing money path; applies on the next sandbox spawn.',
    match: (key: string) => key.startsWith('sandbox_'),
  },
  {
    id: 'host',
    title: 'Host-side calls',
    blurb:
      'Non-agent LLM calls the host makes directly — lead-ranking, win-confidence, and the sanitization / kit-redaction belts.',
    match: () => true,
  },
] as const

/**
 * The §24.163 model-control surface: every model the system runs, explicit and
 * per-surface. Reuses the shared `KnobControl` row (so a write goes through the
 * same allow-listed, optimistic path); groups the `models` knobs into Owner /
 * Sandbox / Host sections. No reset-all here — that lever resets EVERY admin knob,
 * which would be a surprise from a Models tab; per-knob ↺ reset stays.
 */
export function ModelControls({ knobs, onWrite, onReset }: ModelControlsProps) {
  const sections = SECTIONS.map((s) => ({ ...s, items: [] as DevKnob[] }))
  for (const knob of knobs) {
    const target = sections.find((s) => s.match(knob.key))
    if (target) target.items.push(knob)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Every model the system runs, explicit and per-surface. Defaults are all Sonnet / Haiku; crank a single surface
        to Opus where you observe a quality gap. Changes apply on that surface’s next container spawn.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {sections
          .filter((s) => s.items.length > 0)
          .map((s) => (
            <Card key={s.id} data-testid={`model-section-${s.id}`}>
              <CardHeader className="px-4 pb-2 sm:px-6">
                <CardTitle className="text-base">{s.title}</CardTitle>
                <p className="text-xs text-muted-foreground">{s.blurb}</p>
              </CardHeader>
              <CardContent className="divide-y divide-border/60 px-4 pt-0 sm:px-6">
                {s.items.map((knob) => (
                  <KnobControl key={knob.key} knob={knob} onWrite={onWrite} onReset={onReset} />
                ))}
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  )
}
