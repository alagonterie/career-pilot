import { motion } from 'motion/react'
import * as React from 'react'

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
      data-kit-section={section.id}
      data-testid={sealed ? `kit-sealed-${section.id}` : `kit-section-${section.id}`}
      aria-labelledby={`kit-h-${section.id}`}
      // Mobile clears the header (57px) + the sticky chip bar (~43px) — 96px
      // tucked the first line under the bar (owner phone pass, §24.65 Δ);
      // desktop has only the header, so the tighter offset returns at lg.
      className="scroll-mt-28 lg:scroll-mt-24"
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

/**
 * Scroll-spy over the rendered sections. The observation band starts at the
 * tap-scroll landing offset (scroll-mt-24 = 96px) so the section a TOC tap
 * scrolls to is the one that lights up — the owner's phone pass caught the
 * old viewport-percentage band skipping short sealed sections and
 * highlighting their neighbor (§24.65 Δ). A tap also sets the highlight
 * explicitly and suppresses the observer while the smooth scroll settles.
 */
function useScrollSpy(
  ids: string[],
  setActive: (id: string | null) => void,
  suppressUntil: React.MutableRefObject<number>,
): void {
  React.useEffect(() => {
    if (ids.length === 0 || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressUntil.current) return
        // Topmost intersecting section wins; entries arrive unordered.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length > 0) setActive(visible[0].target.getAttribute('data-kit-section'))
      },
      { rootMargin: '-96px 0px -55% 0px' },
    )
    for (const id of ids) {
      const el = document.querySelector(`[data-kit-section="${id}"]`)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [ids, setActive, suppressUntil])
}

function TocEntry({
  section,
  active,
  onSelect,
  variant,
}: {
  section: KitSection
  active: boolean
  onSelect: (id: string) => void
  variant: 'rail' | 'chip'
}) {
  const sealed = section.kind === 'withheld'
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      data-testid="kit-toc-entry"
      data-section-id={section.id}
      data-sealed={sealed || undefined}
      data-active={active || undefined}
      className={cn(
        'font-mono text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'rail' ? 'block w-full truncate py-1 text-left' : 'shrink-0 rounded-full border px-2.5 py-1',
        active
          ? variant === 'rail'
            ? 'text-foreground'
            : 'border-primary/50 text-foreground'
          : variant === 'rail'
            ? 'text-muted-foreground hover:text-foreground'
            : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {sealed ? <span aria-hidden="true">⊘ </span> : null}
      {section.title}
    </button>
  )
}

export function KitDossier({ kit }: { kit: KitPayload }) {
  const sections = kit.sections
  const ids = React.useMemo(() => sections.map((s) => s.id), [sections])
  const [active, setActive] = React.useState<string | null>(null)
  // While a tap-initiated smooth scroll settles, the observer stays quiet so
  // the tapped chip keeps the highlight (it owns it; the spy resumes after).
  const suppressUntil = React.useRef(0)
  const stripRef = React.useRef<HTMLDivElement>(null)
  useScrollSpy(ids, setActive, suppressUntil)

  const jump = (id: string): void => {
    suppressUntil.current = Date.now() + 900
    setActive(id)
    const el = document.querySelector(`[data-kit-section="${id}"]`)
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  // Keep the active chip visible inside the horizontal strip (the prev/next
  // steppers can move the highlight to a chip that's scrolled out of view).
  // INSTANT, not smooth: Chromium runs ONE smooth-scroll animation at a time,
  // so a smooth strip scroll CANCELLED the in-flight smooth page scroll —
  // which only fired when the target chip was out of view, i.e. always on ‹
  // (strip scrolled right, prev chip off-left) and on long › jumps. The
  // owner's "back scrolling doesn't work at all / forward mostly works"
  // (§24.65 Δ).
  React.useEffect(() => {
    const strip = stripRef.current
    if (!strip || !active) return
    const chip = strip.querySelector<HTMLElement>(`[data-section-id="${active}"]`)
    if (!chip) return
    const left = chip.offsetLeft - strip.offsetLeft
    if (left < strip.scrollLeft || left + chip.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo?.({ left: Math.max(0, left - 24), behavior: 'auto' })
    }
  }, [active])

  // Prev/next step between sections WITH CONTENT (§24.65 Δ, owner ask): on a
  // phone the sealed chips dominate the strip, so finding the next readable
  // section meant scrolling the strip to hunt for an un-⊘ chip.
  const activeIdx = active ? ids.indexOf(active) : -1
  const nextContent = sections.find((s, i) => i > activeIdx && s.kind === 'content')
  const prevContent = [...sections.slice(0, Math.max(0, activeIdx))].reverse().find((s) => s.kind === 'content')

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
    <motion.div
      data-testid="kit-dossier"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="lg:grid lg:grid-cols-[11rem_1fr] lg:gap-8"
    >
      {/* Mobile: a horizontal chip row pinned under the site header. top-14
          (56px) tucks 1px under the header's border — top-[57px] left a
          subpixel sliver of page content visible between them on phones
          (§24.65 Δ, owner phone pass). */}
      <nav
        aria-label="Kit sections (quick nav)"
        data-testid="kit-toc"
        className="sticky top-14 z-10 -mx-6 flex items-center gap-1 border-b border-border bg-background/95 px-2 py-2 backdrop-blur lg:hidden"
      >
        <button
          type="button"
          aria-label="Previous section with content"
          data-testid="kit-toc-prev"
          disabled={!prevContent}
          onClick={() => prevContent && jump(prevContent.id)}
          className="shrink-0 rounded-full border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ‹
        </button>
        <div ref={stripRef} className="flex min-w-0 flex-1 gap-2 overflow-x-auto px-1">
          {sections.map((s) => (
            <TocEntry key={s.id} section={s} active={active === s.id} onSelect={jump} variant="chip" />
          ))}
        </div>
        <button
          type="button"
          aria-label="Next section with content"
          data-testid="kit-toc-next"
          disabled={!nextContent}
          onClick={() => nextContent && jump(nextContent.id)}
          className="shrink-0 rounded-full border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ›
        </button>
      </nav>

      {/* Desktop: a slim sticky rail. */}
      <nav aria-label="Kit sections" className="hidden lg:block">
        <div className="sticky top-24 flex flex-col border-l border-border pl-3">
          {sections.map((s) => (
            <TocEntry key={s.id} section={s} active={active === s.id} onSelect={jump} variant="rail" />
          ))}
        </div>
      </nav>

      <div className="mt-6 flex min-w-0 flex-col gap-7 lg:mt-0">{blocks}</div>
    </motion.div>
  )
}
