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
          // -translate-y-px (§24.86): every InfoTip sits next to UPPERCASE text in
          // an items-center wrapper, which centers the circle on the text's line
          // box — but all-caps ink sits high in that box (empty descender space), so
          // the circle read ~1px low. The nudge optically centers it on the caps.
          className="inline-flex h-3.5 w-3.5 shrink-0 -translate-y-px items-center justify-center rounded-full border border-muted-foreground/50 align-middle text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* The "i" as a centered SVG (§24.85): a flex-centered text glyph
              centers on its advance box, not its ink, so the sans "i"'s
              side-bearings + baseline left it visibly off-center. A symmetric
              viewBox has neither — the dot + stem are pixel-centered everywhere. */}
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3" fill="currentColor">
            <circle cx="8" cy="4" r="1.5" />
            <rect x="6.7" y="6.5" width="2.6" height="7" rx="1.3" />
          </svg>
        </button>
      )}
    >
      {children}
    </DisclosureTip>
  )
}
