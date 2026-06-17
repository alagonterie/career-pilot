import { AgentRef } from './AgentRef'
import { resolveActor } from '~/lib/ai-actors'
import { type AuditEvent, eventSourceLabel } from '~/lib/use-activity-stream'

/**
 * An activity event's source label (§24.73): when it's a named member of the AI
 * cast (a subagent / the orchestrator) it renders as an explainable AgentRef —
 * the same chip the simulator trace uses, so the live feeds speak the one
 * AI-authorship language. Category-derived labels that aren't agents ("pipeline"
 * = the board, "system") stay in the plain link register. The audit data is
 * natively visitor-facing (§24.77 D3 / migration 137) — no alias step; the row's
 * own `agent_name`/`category` is what `resolveActor` sees.
 */
export function EventSourceLabel({ event }: { event: AuditEvent }) {
  const label = eventSourceLabel(event)
  return resolveActor(label) ? <AgentRef name={label} /> : <span className="text-accent-cool">{label}</span>
}
