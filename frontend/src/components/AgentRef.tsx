import { DisclosureTip } from './DisclosureTip'
import { type AiActor, resolveActor } from '~/lib/ai-actors'
import { cn } from '~/lib/utils'

/**
 * An explainable reference to a member of the AI cast (§24.73). Renders the
 * actor's handle as an interactive term — AI-violet, dotted underline — that
 * taps/clicks open a short popover explaining who it is: role, what it does,
 * and an honest capability badge. Every place the site names an agent routes
 * through this, so `tailor-resume` in the simulator trace, the `/kit` footer,
 * and the win-confidence rationale all become a consistent tour of the cast
 * instead of bare jargon a recruiter has to decode.
 *
 * An unknown name renders as plain text — never a false attribution, never a
 * dead popover. The trigger is a `<button>`, so callers must not nest it inside
 * another button (use a non-interactive container, or the plain-text form).
 */

const KIND_NOTE: Record<AiActor['kind'], string> = {
  subagent: 'a specialist subagent',
  host: 'a host-side model, outside the agent loop',
  system: 'the orchestrating agent',
}

export function AgentRef({ name, className }: { name: string; className?: string }) {
  const actor = resolveActor(name)
  if (!actor) return <span className={cn('font-mono', className)}>{name}</span>

  return (
    <DisclosureTip
      ariaLabel={`About ${actor.name}, ${KIND_NOTE[actor.kind]}`}
      panelTestId="agent-ref-panel"
      panelWidth={288}
      trigger={(p) => (
        <button
          ref={p.ref}
          type="button"
          data-testid="agent-ref"
          data-actor={actor.name}
          aria-expanded={p['aria-expanded']}
          aria-controls={p['aria-controls']}
          aria-label={p['aria-label']}
          onClick={p.onClick}
          className={cn(
            'cursor-help align-baseline font-mono text-ai underline decoration-dotted decoration-ai/50 underline-offset-2 transition-colors hover:decoration-ai focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          {actor.name}
        </button>
      )}
    >
      <span className="block font-mono text-[11px] font-semibold uppercase tracking-widest text-ai">{actor.role}</span>
      <span className="mt-1 block text-muted-foreground">{actor.blurb}</span>
      <span className="mt-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <span aria-hidden="true" className="text-ai">
          ✦
        </span>
        {actor.access}
      </span>
    </DisclosureTip>
  )
}
