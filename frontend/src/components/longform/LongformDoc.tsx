import { motion } from 'motion/react'
import * as React from 'react'

import { cn } from '~/lib/utils'

/**
 * The shared long-form reading scaffold (STRATEGY §24.83): a document body with a
 * sticky scroll-spy table of contents — a slim left rail on desktop, a horizontal
 * chip row pinned under the site header on mobile — plus an optional ‹ › stepper.
 * Extracted out of the /kit dossier (PORTAL §5.9) so the site's other walls of
 * text — /about (§5.8) and /experience (§5.6) — get the same navigation.
 *
 * The scaffold is content-agnostic: it owns the nav + the active-section tracking
 * + the (carefully tuned, §24.65) jump/scroll behavior, and renders each
 * consumer's section blocks as `children`. The contract a consumer must honor:
 * every navigable section element carries `data-longform-section={section.id}`
 * (the scroll-spy observes by that attribute) and the shared scroll-margin
 * (`LONGFORM_SCROLL_MT`) so a tap lands the section clear of the sticky chip bar.
 * Non-section content (part headers, intros) simply omits the attribute.
 */

export type DocSection = { id: string; title: string; sealed?: boolean }

/**
 * The scroll-margin every navigable section element must carry. Mobile clears the
 * header (57px) + the sticky chip bar (~43px) — 96px tucked the first line under
 * the bar; desktop has only the header, so the tighter offset returns at lg
 * (§24.65 Δ, owner phone pass). Matches the scroll-spy's `rootMargin` top band.
 */
export const LONGFORM_SCROLL_MT = 'scroll-mt-28 lg:scroll-mt-24'

/**
 * Scroll-spy over the rendered sections. The observation band starts at the
 * tap-scroll landing offset (scroll-mt-24 = 96px) so the section a TOC tap
 * scrolls to is the one that lights up — the owner's phone pass caught the old
 * viewport-percentage band skipping short sealed sections and highlighting their
 * neighbor (§24.65 Δ). A tap also sets the highlight explicitly and suppresses
 * the observer while the smooth scroll settles.
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
        if (visible.length > 0) setActive(visible[0].target.getAttribute('data-longform-section'))
      },
      { rootMargin: '-96px 0px -55% 0px' },
    )
    for (const id of ids) {
      const el = document.querySelector(`[data-longform-section="${id}"]`)
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
  idPrefix,
}: {
  section: DocSection
  active: boolean
  onSelect: (id: string) => void
  variant: 'rail' | 'chip'
  idPrefix: string
}) {
  const sealed = section.sealed
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      data-testid={`${idPrefix}-toc-entry`}
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

export function LongformDoc({
  sections,
  idPrefix,
  navLabel,
  stepper = false,
  contentClassName,
  children,
}: {
  sections: DocSection[]
  /** Namespaces the test-ids (`${idPrefix}-dossier` / `-toc` / `-toc-entry` / `-toc-prev` / `-toc-next`). */
  idPrefix: string
  /** Accessible name for the two TOC nav landmarks (the mobile one appends "(quick nav)"). */
  navLabel: string
  /** Render the mobile ‹ › steppers that jump between non-sealed sections (kit; off for prose docs). */
  stepper?: boolean
  /** Classes for the content column (the consumer owns its inner spacing, e.g. `flex flex-col gap-7`). */
  contentClassName?: string
  children: React.ReactNode
}) {
  const ids = React.useMemo(() => sections.map((s) => s.id), [sections])
  const [active, setActive] = React.useState<string | null>(null)
  // While a tap-initiated smooth scroll settles, the observer stays quiet so the
  // tapped chip keeps the highlight (it owns it; the spy resumes after).
  const suppressUntil = React.useRef(0)
  const stripRef = React.useRef<HTMLDivElement>(null)
  useScrollSpy(ids, setActive, suppressUntil)

  // Bring a chip into the strip's view, instantly.
  const revealChip = React.useCallback((id: string): void => {
    const strip = stripRef.current
    if (!strip) return
    const chip = strip.querySelector<HTMLElement>(`[data-section-id="${id}"]`)
    if (!chip) return
    const left = chip.offsetLeft - strip.offsetLeft
    if (left < strip.scrollLeft || left + chip.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo?.({ left: Math.max(0, left - 24), behavior: 'auto' })
    }
  }, [])

  // The two scrolls (strip + page) must NEVER overlap in time: Chromium kills the
  // document's in-flight smooth scroll when ANY programmatic scroll — even an
  // instant one on a different element — lands (probed: ‹ moved 0px, long › died
  // mid-flight, exactly when the chip was out of strip view; the round-2 "make the
  // strip scroll instant" fix wasn't enough, §24.65 Δ). So: strip first (instant,
  // synchronous), page scroll one frame later, and the effect below skips
  // jump-driven active changes entirely.
  const jumpHandledStrip = React.useRef(false)
  const jump = (id: string): void => {
    suppressUntil.current = Date.now() + 900
    jumpHandledStrip.current = true
    setActive(id)
    revealChip(id)
    const el = document.querySelector(`[data-longform-section="${id}"]`)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
    } else {
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }
  }

  // Observer-driven active changes (the user scrolling the page themselves) still
  // keep the chip visible; a user-driven scroll has no animation to kill.
  React.useEffect(() => {
    if (jumpHandledStrip.current) {
      jumpHandledStrip.current = false
      return
    }
    if (active) revealChip(active)
  }, [active, revealChip])

  // Prev/next step between non-sealed sections (§24.65 Δ, owner ask): on a phone
  // the sealed chips dominate the strip, so finding the next readable section
  // meant scrolling the strip to hunt for an un-⊘ chip.
  const activeIdx = active ? ids.indexOf(active) : -1
  const nextContent = sections.find((s, i) => i > activeIdx && !s.sealed)
  const prevContent = [...sections.slice(0, Math.max(0, activeIdx))].reverse().find((s) => !s.sealed)

  return (
    <motion.div
      data-testid={`${idPrefix}-dossier`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="lg:grid lg:grid-cols-[11rem_1fr] lg:gap-8"
    >
      {/* Mobile: a horizontal chip row pinned under the site header. top-14 (56px)
          tucks 1px under the header's border — top-[57px] left a subpixel sliver
          of page content visible between them on phones (§24.65 Δ, owner phone
          pass). */}
      <nav
        aria-label={`${navLabel} (quick nav)`}
        data-testid={`${idPrefix}-toc`}
        className="sticky top-14 z-10 -mx-6 flex items-center gap-1 border-b border-border bg-background/95 px-2 py-2 backdrop-blur lg:hidden"
      >
        {stepper ? (
          <button
            type="button"
            aria-label="Previous section with content"
            data-testid={`${idPrefix}-toc-prev`}
            disabled={!prevContent}
            onClick={() => prevContent && jump(prevContent.id)}
            className="shrink-0 rounded-full border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ‹
          </button>
        ) : null}
        <div ref={stripRef} className="flex min-w-0 flex-1 gap-2 overflow-x-auto px-1">
          {sections.map((s) => (
            <TocEntry
              key={s.id}
              section={s}
              active={active === s.id}
              onSelect={jump}
              variant="chip"
              idPrefix={idPrefix}
            />
          ))}
        </div>
        {stepper ? (
          <button
            type="button"
            aria-label="Next section with content"
            data-testid={`${idPrefix}-toc-next`}
            disabled={!nextContent}
            onClick={() => nextContent && jump(nextContent.id)}
            className="shrink-0 rounded-full border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ›
          </button>
        ) : null}
      </nav>

      {/* Desktop: a slim sticky rail. */}
      <nav aria-label={navLabel} className="hidden lg:block">
        <div className="sticky top-24 flex flex-col border-l border-border pl-3">
          {sections.map((s) => (
            <TocEntry
              key={s.id}
              section={s}
              active={active === s.id}
              onSelect={jump}
              variant="rail"
              idPrefix={idPrefix}
            />
          ))}
        </div>
      </nav>

      <div className={cn('mt-6 min-w-0 lg:mt-0', contentClassName)}>{children}</div>
    </motion.div>
  )
}
