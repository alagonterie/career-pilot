import { DisclosureTip } from './DisclosureTip'

/**
 * A tap/click disclosure for metric jargon (PORTAL §5.2 / STRATEGY §24.57): the
 * mobile-capable replacement for desktop-only `title` attributes on the ops
 * register's vocabulary (`spend · est`, cache rate, p50/p95, the turn seal). A
 * small ⓘ trigger toggles a short explainer panel.
 *
 * The disclosure mechanics (portal positioning, Esc/outside-tap/scroll dismiss,
 * a11y) live in the shared `DisclosureTip` (§24.73) so the ⓘ tip and the
 * `AgentRef` cast chip share ONE interaction contract — InfoTip is just its
 * ⓘ-trigger skin.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DisclosureTip
      ariaLabel={`About: ${label}`}
      panelTestId="info-tip-panel"
      panelWidth={256}
      panelClassName="text-muted-foreground"
      trigger={(p) => (
        <button
          ref={p.ref}
          type="button"
          data-testid="info-tip-trigger"
          aria-expanded={p['aria-expanded']}
          aria-controls={p['aria-controls']}
          aria-label={p['aria-label']}
          onClick={p.onClick}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 align-middle font-sans text-[9px] leading-none text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          i
        </button>
      )}
    >
      {children}
    </DisclosureTip>
  )
}
