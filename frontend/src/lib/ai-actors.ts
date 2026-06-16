/**
 * The cast registry (§24.73 — the AI-authorship design language). The ONE place
 * the site's AI actors are described, so every mention — the simulator trace,
 * the /kit footer, the architecture panel, the win-confidence rationale, the
 * ✦ provenance marks — agrees on who an actor is and what it does. Before this,
 * the cast lived as prose in a single architecture node and as bare strings
 * everywhere else.
 *
 * It's a registry of AI *actors*, not just subagents, because honesty demands
 * it: the win-confidence score and the public-view sanitizer are host-side LLM
 * calls that run OUTSIDE the orchestrator's agent loop — attributing them to a
 * subagent would be a fabrication. `kind` keeps that distinction visible:
 *   - 'subagent' — a specialist the orchestrator dispatches inside the loop
 *   - 'host'     — a host-side model, on its own, outside the loop
 *   - 'system'   — the orchestrator itself; the honest fallback for
 *                  whole-system output with no single specialist author
 */

export type ActorKind = 'subagent' | 'host' | 'system'

export interface AiActor {
  /** Canonical handle — also the chip text (mono). The cast's public "names". */
  name: string
  /** Short human role, e.g. "Résumé tailor". */
  role: string
  /** Visitor-facing one-liner shown in the AgentRef popover. */
  blurb: string
  /** Honest, short capability badge, e.g. "reads only". */
  access: string
  kind: ActorKind
  /** Wire/display-name variants that should resolve to this actor. */
  aliases?: string[]
}

/**
 * Ordered cast — subagents first (in dispatch-relevance order), then the
 * host-side actors, then the system fallback. The architecture panel and the
 * registry-completeness test iterate this.
 */
export const AI_ACTORS: AiActor[] = [
  {
    name: 'research-company',
    role: 'Company researcher',
    blurb:
      'Digs into a target company — product, tech, what they’re hiring for — and produces the briefing the other agents build on.',
    access: 'reads only',
    kind: 'subagent',
  },
  {
    name: 'tailor-resume',
    role: 'Résumé tailor',
    blurb:
      'Rewrites my master résumé for one specific role, foregrounding the experience that fits. Never invents facts.',
    access: 'reads only',
    kind: 'subagent',
  },
  {
    name: 'draft-outreach',
    role: 'Outreach writer',
    blurb:
      'Writes a personalized cold-outreach email. In my real search it lands as a Gmail draft I review before anything sends.',
    access: 'writes reversible drafts',
    kind: 'subagent',
  },
  {
    name: 'build-interview-kit',
    role: 'Interview-kit builder',
    blurb:
      'When an application reaches an interview round, builds a two-part mock-interview kit — an interviewer manual and a phone cheat-sheet — as a private Google Doc.',
    access: 'writes private Docs',
    kind: 'subagent',
  },
  {
    name: 'scrape-jobs',
    role: 'Job scout',
    blurb:
      'Continuously queries a live jobs index for fresh postings, filling the pool of leads the search works from. Not an LLM call — a plain search.',
    access: 'fills the leads pool',
    kind: 'subagent',
  },
  {
    name: 'pipeline-scribe',
    role: 'Pipeline curator',
    blurb:
      'Keeps the public pipeline honest — writes the published notes and curates which applications are safe to reveal.',
    access: 'curates the public view',
    kind: 'subagent',
    // Historical audit rows carry the pre-rename agent_name; resolve it here.
    aliases: ['funnel-curator'],
  },
  {
    name: 'win-confidence',
    role: 'Win-confidence scorer',
    blurb:
      'A host model that scores each application’s odds of becoming an offer and writes the one-line rationale. It runs on its own, outside the agent loop.',
    access: 'host-side · reads the funnel',
    kind: 'host',
    aliases: ['win confidence', 'win_confidence'],
  },
  {
    name: 'sanitizer',
    role: 'Sanitizer',
    blurb:
      'A host model on the public read path that scrubs anything company-identifying out of the view before it’s shown.',
    access: 'host-side · public read path',
    kind: 'host',
    aliases: ['sanitization', 'sanitize'],
  },
  {
    name: 'my agent system',
    role: 'Orchestrator',
    blurb: 'The orchestrating agent that runs my search end-to-end and dispatches the specialist subagents.',
    access: 'runs the whole loop',
    kind: 'system',
    aliases: ['orchestrator', 'agent-system', 'agent system'],
  },
]

const BY_NAME: Record<string, AiActor> = Object.fromEntries(AI_ACTORS.map((a) => [a.name.toLowerCase(), a]))

/** The system/orchestrator fallback — the honest author of whole-system output. */
export const SYSTEM_ACTOR: AiActor = BY_NAME['my agent system']

/**
 * Resolve a raw name/label (a registry key, an alias, or a wire dispatch label
 * that may carry extra prefix/suffix) to an actor. Direct match → alias match →
 * substring match. Returns null when nothing in the cast is named.
 */
export function resolveActor(raw: string | null | undefined): AiActor | null {
  if (!raw) return null
  const k = raw.trim().toLowerCase()
  if (!k) return null
  if (BY_NAME[k]) return BY_NAME[k]
  for (const a of AI_ACTORS) {
    if (a.aliases?.some((al) => al.toLowerCase() === k)) return a
  }
  for (const a of AI_ACTORS) {
    if (k.includes(a.name.toLowerCase())) return a
    if (a.aliases?.some((al) => k.includes(al.toLowerCase()))) return a
  }
  return null
}

/**
 * The natural plain-text reference for an actor — for non-interactive surfaces
 * (the PDF footer, alt text) where the AgentRef chip can't render. Signals the
 * name belongs to an AI agent without the popover.
 */
export function actorPlainText(a: AiActor): string {
  if (a.kind === 'subagent') return `the ${a.name} agent`
  if (a.kind === 'host') return `the ${a.name} model`
  return a.name // system: reads as "my agent system"
}
