import * as React from 'react'

import { DocSection, LONGFORM_SCROLL_MT, LongformDoc } from '~/components/longform/LongformDoc'
import { renderMarkdownish } from '~/lib/markdownish'
import type { KitPayload, KitSection } from '~/lib/use-kit'
import { cn } from '~/lib/utils'

/**
 * The /kit dossier body (PORTAL §5.9 / STRATEGY §24.65): the complete document
 * skeleton — every section the kit has, in order — with real content where the
 * per-section policy allows and redaction bars where it doesn't. The seal is
 * server-side; a `withheld` section arrives as a count + caption with NO text,
 * so the bars here are decoration over an already-safe payload (never a
 * client-side hide).
 *
 * The reading scaffold (masthead-less here; the masthead lives on the page) —
 * the sticky scroll-spy TOC + ‹ › steppers — is the shared `LongformDoc`
 * (STRATEGY §24.83); this component owns only the kit-specific rendering (part
 * framing, redaction bars, the Part-2 pocket card) and the sealed semantics.
 */

const PART_HEADERS: Record<number, { title: string; caption: string }> = {
  1: {
    title: 'Part 1 — Interviewer operating manual',
    caption: 'read by the interviewer Claude during the voice mock',
  },
  2: {
    title: 'Part 2 — Candidate quick-reference',
    caption: 'the candidate’s phone cheat-sheet',
  },
}

// Deterministic per-index bar widths (stable visual baselines — no randomness).
const BAR_WIDTHS = [92, 74, 86, 63, 80, 70]
const MAX_BARS = 8

function RedactionBars({ count }: { count: number }) {
  const bars = Math.max(1, Math.min(MAX_BARS, count))
  return (
    <div aria-hidden="true" data-testid="kit-redaction-bars" className="flex flex-col gap-1.5">
      {Array.from({ length: bars }, (_, i) => (
        <div
          key={i}
          className="h-3 rounded-sm bg-[repeating-linear-gradient(135deg,var(--color-muted),var(--color-muted)_6px,transparent_6px,transparent_10px)] opacity-70"
          style={{ width: `${BAR_WIDTHS[i % BAR_WIDTHS.length]}%` }}
        />
      ))}
    </div>
  )
}

function SectionBlock({ section }: { section: KitSection }) {
  const sealed = section.kind === 'withheld'
  return (
    <section
      id={`kit-sec-${section.id}`}
      data-longform-section={section.id}
      data-testid={sealed ? `kit-sealed-${section.id}` : `kit-section-${section.id}`}
      aria-labelledby={`kit-h-${section.id}`}
      className={LONGFORM_SCROLL_MT}
    >
      <h3
        id={`kit-h-${section.id}`}
        className="flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-primary"
      >
        {sealed ? (
          <span aria-hidden="true" className="text-muted-foreground">
            ⊘
          </span>
        ) : null}
        {section.title}
      </h3>
      {sealed ? (
        <div className="mt-2 flex flex-col gap-2">
          <RedactionBars count={section.item_count ?? 1} />
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{section.withheld_reason}</p>
        </div>
      ) : (
        <div className="mt-2 max-w-prose">{renderMarkdownish(section.body ?? '')}</div>
      )}
    </section>
  )
}

export function KitDossier({ kit }: { kit: KitPayload }) {
  const sections = kit.sections

  // The TOC model the scaffold consumes: sealed = withheld (keeps the section in
  // the rail with a ⊘ glyph, and the steppers skip it).
  const docSections: DocSection[] = React.useMemo(
    () => sections.map((s) => ({ id: s.id, title: s.title, sealed: s.kind === 'withheld' })),
    [sections],
  )

  // Render in document order, emitting the part framing when the part changes.
  const blocks: React.ReactNode[] = []
  let currentPart = -1
  for (const section of sections) {
    if (section.part !== currentPart && PART_HEADERS[section.part]) {
      const ph = PART_HEADERS[section.part]
      blocks.push(
        <header key={`part-${section.part}`} className={cn(section.part === 2 && 'mt-2')}>
          <h2 className="font-mono text-sm font-semibold text-foreground">{ph.title}</h2>
          <p className="mt-0.5 text-xs italic text-muted-foreground">{ph.caption}</p>
        </header>,
      )
    }
    currentPart = section.part
    // Part 2 is the pocket artifact — its sections render inside a tighter card.
    if (section.part === 2) {
      blocks.push(
        <div key={section.id} className="rounded-lg border border-border bg-card p-4">
          <SectionBlock section={section} />
        </div>,
      )
    } else {
      blocks.push(<SectionBlock key={section.id} section={section} />)
    }
  }

  return (
    <LongformDoc
      sections={docSections}
      idPrefix="kit"
      navLabel="Kit sections"
      stepper
      contentClassName="flex flex-col gap-7"
    >
      {blocks}
    </LongformDoc>
  )
}
