import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { DevKnob, KnobGroup, KnobWriteResult } from '~/lib/use-dev-inspector'

import { KnobControl } from './KnobControl'

// Operational levers first; the dev-only `sim` + `models` groups sit last (they
// only appear on /dev — /admin's feed excludes them via ADMIN_DENY).
const GROUP_ORDER: KnobGroup[] = [
  'budget',
  'simulator',
  'contact',
  'briefing',
  'scouting',
  'curator',
  'kits',
  'sanitization',
  'sessions',
  'system',
  'telemetry',
  'health',
  'notify',
  'polling',
  'sim',
  'models',
]

const GROUP_META: Record<KnobGroup, { title: string; blurb: string }> = {
  budget: { title: 'Budgets & caps', blurb: 'Daily LLM spend ceilings + per-run/per-IP caps across the system.' },
  simulator: {
    title: 'Public simulator',
    blurb: 'The visitor demo (the only money-spend public path): the kill switch + per-run turn/time/result caps.',
  },
  contact: {
    title: 'Contact relay',
    blurb:
      'Abuse backstops for the public /contact relay (it spends no money — junk only risks Telegram spam + DB rows). Kill switch + a global flood cap behind the per-IP edge limit.',
  },
  briefing: {
    title: 'Daily briefing',
    blurb: 'The scheduled briefing: cadence, scoring threshold, size, and its host backstop.',
  },
  scouting: {
    title: 'Scouting & killer-match',
    blurb: 'The job-lead scrape + the high-score "this one’s for you" alert.',
  },
  curator: {
    title: 'Pipeline curator',
    blurb: 'The pipeline-scribe + close-detection passes — cadence, lookback, and per-pass ceilings.',
  },
  kits: { title: 'Interview kits', blurb: 'Auto-generation, the Drive destination, and the stale-kit cleanup.' },
  sanitization: {
    title: 'Sanitization & redaction',
    blurb: 'The public-text scrub + the kit entity-redaction belt: toggles, models, thresholds, and timeouts.',
  },
  sessions: {
    title: 'Ops session',
    blurb:
      'Transcript rotation + chat mirroring + the idle-container ceilings. Rotation changes apply on the next spawn.',
  },
  system: {
    title: 'System & perf',
    blurb: 'Container sizing + concurrency, SSE/cache timings, and host-side perf internals.',
  },
  telemetry: {
    title: 'Telemetry',
    blurb: 'Per-request + visit telemetry capture and retention windows.',
  },
  health: {
    title: 'Health checks',
    blurb:
      'The proactive health-run cadence + the per-finding thresholds (new criticals ping the owner once until cleared).',
  },
  notify: { title: 'Notifications', blurb: 'Quiet hours, the proactive frequency cap, and the auto-research trigger.' },
  polling: {
    title: 'Polling',
    blurb: 'Intended Gmail / Calendar poll cadence (no live consumer today — kept for a future poller).',
  },
  sim: { title: 'Recruiter sim', blurb: 'Dev-only: the fixture that injects ATS mail into the dev mailbox.' },
  models: {
    title: 'Model tier',
    blurb:
      'Dev-only: drop the orchestrator + subagents off Opus for cheap dev runs (applies on the next spawn). The cost delta shows up in Portkey.',
  },
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
