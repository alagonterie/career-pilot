import { AgentRef } from './AgentRef'
import { resolveActor } from '~/lib/ai-actors'
import { type AuditEvent, eventSourceLabel } from '~/lib/use-activity-stream'

/**
 * An activity event's source label (§24.73): when it's a named member of the AI
 * cast (a subagent / the orchestrator) it renders as an explainable AgentRef —
 * the same chip the simulator trace uses, so the live feeds speak the one
 * AI-authorship language. Category-derived labels that aren't agents ("pipeline"
 * = the board, "system") stay in the plain link register. The alias resolution
 * (`funnel-curator`→`pipeline-scribe`, `funnel`→`pipeline`) happens in
 * `eventSourceLabel` first, so `resolveActor` sees the display name.
 */
export function EventSourceLabel({ event }: { event: AuditEvent }) {
  const label = eventSourceLabel(event)
  return resolveActor(label) ? <AgentRef name={label} /> : <span className="text-accent-cool">{label}</span>
}
