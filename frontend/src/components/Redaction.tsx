import { cn } from '~/lib/utils'

/**
 * The universal redaction chip (STRATEGY §24.134d). Every `[…REDACTED…]` token
 * the sanitizer leaves in public-bound text renders through this, with the
 * provenance tier read from the token SHAPE — so the page is HONEST about which
 * pass did the redacting (the `--ai` violet means "an AI did this", §24.73):
 *
 *   [AI_REDACTED]        → ai      — the entity-belt's judgment pass (§24.134a)
 *   [REDACTED:<label>]   → company — Pass-2 DB swap; chip shows the pseudonym
 *   [EMAIL|PHONE|AMOUNT|SSN_REDACTED] → pii — Pass-1 regex
 *   [REDACTED]           → generic — Pass-1 URL-query PII (bare)
 *
 * Non-interactive by design: a kit carries dozens, so these are styled spans
 * with a hover `title`, NOT `DisclosureTip` buttons like AgentRef (dozens of
 * tab-stops/popovers would be the noise we're avoiding). The one-time
 * `RedactionLegend` carries the fuller explanation.
 */

export type RedactionTier = 'ai' | 'company' | 'pii' | 'generic'

export interface ParsedRedaction {
  tier: RedactionTier
  display: string
  glyph?: string
  title: string
}

// Split-capturing (global) + exact-match (non-global) — kept separate because
// `.test()` on a /g regex is stateful.
const SPLIT_RE = /(\[(?:[A-Z]+_)?REDACTED(?::[^\]]+)?\])/g
const MATCH_RE = /^\[(?:[A-Z]+_)?REDACTED(?::[^\]]+)?\]$/

const PII_GLYPH: Record<string, { glyph: string; title: string }> = {
  EMAIL: { glyph: '✉', title: 'Contact detail removed.' },
  PHONE: { glyph: '☎', title: 'Contact detail removed.' },
  AMOUNT: { glyph: '$', title: 'A figure was removed.' },
  SSN: { glyph: '#', title: 'A sensitive identifier was removed.' },
}

export function parseRedaction(token: string): ParsedRedaction {
  const company = token.match(/^\[REDACTED:(.+)\]$/)
  if (company) {
    return {
      tier: 'company',
      display: company[1],
      title: 'Company anonymized — a stable handle kept while this process is live.',
    }
  }
  if (token === '[AI_REDACTED]') {
    return {
      tier: 'ai',
      glyph: '✦',
      display: 'redacted',
      title: "Redacted by the agent's anonymization pass while this role is live.",
    }
  }
  const typed = token.match(/^\[([A-Z]+)_REDACTED\]$/)
  if (typed) {
    const m = PII_GLYPH[typed[1]]
    return { tier: 'pii', glyph: m?.glyph, display: 'hidden', title: m?.title ?? 'An identifying detail was removed.' }
  }
  return { tier: 'generic', display: 'hidden', title: 'An identifying detail was removed.' }
}

export function Redaction({ token }: { token: string }) {
  const r = parseRedaction(token)
  const isAi = r.tier === 'ai'
  return (
    <span
      data-testid="redaction-chip"
      data-tier={r.tier}
      title={r.title}
      className={cn(
        'mx-0.5 inline-flex cursor-help items-center gap-1 rounded px-1.5 align-baseline font-mono text-[0.78em] leading-snug ring-1 ring-inset',
        // §24.134d: violet stays, dialed back a notch (owner: "slightly too
        // vibrant"). The TEXT brightness is contrast-bound (AA 4.5:1 at this size),
        // so the "less pop" comes from a fainter fill + ring — which also lifts
        // contrast vs the dark page.
        isAi ? 'bg-ai/5 text-ai ring-ai/20' : 'bg-muted text-muted-foreground ring-border',
      )}
    >
      {r.glyph ? (
        <span aria-hidden="true" className={isAi ? 'text-ai' : 'text-muted-foreground/70'}>
          {r.glyph}
        </span>
      ) : null}
      {r.display}
    </span>
  )
}

/**
 * Split a string into ordered text / redaction-token parts. Pure (no React) so
 * `renderInline` can interleave chips with its own bold/code handling and the
 * `/live` summary can render chips inline. Empty segments are dropped.
 */
export function splitRedactionParts(text: string): { token: boolean; value: string }[] {
  return text
    .split(SPLIT_RE)
    .filter((s) => s.length > 0)
    .map((value) => ({ token: MATCH_RE.test(value), value }))
}

/** Render plain text with its redaction tokens as chips (no markdown). For the
 * `/live` feed summary and any other bare-text surface. */
export function RedactedText({ text }: { text: string }) {
  return <>{splitRedactionParts(text).map((p, i) => (p.token ? <Redaction key={i} token={p.value} /> : p.value))}</>
}

/** A once-per-page legend that turns the chips from "what broke?" into a legible
 * feature — names the two honest tiers (§24.134d). A bordered, titled key (not a
 * loose run of text, §24.146 A0): it reads as a deliberate component the chips
 * map back to, the way a chart's legend sits apart from the chart. */
export function RedactionLegend() {
  return (
    <div
      data-testid="redaction-legend"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5"
    >
      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/80">
        Redaction key
      </span>
      <dl className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px]">
        <div className="inline-flex items-center gap-1.5">
          <dt>
            <Redaction token="[AI_REDACTED]" />
          </dt>
          <dd className="text-muted-foreground">the agent&apos;s judgment</dd>
        </div>
        <div className="inline-flex items-center gap-1.5">
          <dt>
            <Redaction token="[EMAIL_REDACTED]" />
          </dt>
          <dd className="text-muted-foreground">a deterministic scrub</dd>
        </div>
      </dl>
    </div>
  )
}
