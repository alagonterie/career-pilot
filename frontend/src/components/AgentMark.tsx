import { AgentRef } from './AgentRef'
import { cn } from '~/lib/utils'

/**
 * The ✦ AI-authorship marker (§24.73): the one, consistent way the site says
 * "an AI wrote/built this," built on `AgentRef` so the author is always a
 * named, explainable member of the cast. The ✦ glyph carries the AI accent;
 * `lead`/`trail` frame the attribution in plain language.
 *
 *   <AgentMark actor="tailor-resume" lead="Tailored by" trail="· hire.example.com" />
 *     → ✦ Tailored by ⟨tailor-resume⟩ · hire.example.com
 *
 * Two scales: `inline` for footers / captions / cards, `block` for the header
 * above a wholly AI-authored region (the kit dossier, a rationale, sim prose).
 * Non-interactive surfaces that can't host the popover (the PDF) use the
 * registry's `actorPlainText` instead — same wording, no component.
 */
export function AgentMark({
  actor,
  lead,
  trail,
  variant = 'inline',
  className,
  testId,
}: {
  actor: string
  /** Text before the agent name, e.g. "Composed by", "Built by", "Tailored by". */
  lead?: React.ReactNode
  /** Text/nodes after the name, e.g. "· Jun 16", "— a live voice mock". */
  trail?: React.ReactNode
  variant?: 'inline' | 'block'
  className?: string
  testId?: string
}) {
  return (
    <div
      data-testid={testId ?? 'agent-mark'}
      data-actor={actor}
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono',
        variant === 'block' ? 'text-sm' : 'text-xs',
        className,
      )}
    >
      <span aria-hidden="true" className="text-ai">
        ✦
      </span>
      {lead != null ? <span className="text-muted-foreground">{lead}</span> : null}
      <AgentRef name={actor} />
      {trail != null ? <span className="text-muted-foreground">{trail}</span> : null}
    </div>
  )
}
