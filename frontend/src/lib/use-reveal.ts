import * as React from 'react'

/**
 * Scroll-reveal engine for the `/` scroll pass (§24.147) — below-the-fold
 * sections rise into place as they enter the viewport. Transform-only (the
 * `.cp-reveal` class never touches opacity), per the §24.135 axe constraint.
 *
 * Progressive enhancement is load-bearing here, the same contract as the
 * `cp-rise` hero entrance: this returns `className: ''` on the server AND the
 * first client render, so every section ships VISIBLE in the SSR HTML. A
 * JS-disabled visitor — or one who asked for reduced motion — sees solid content,
 * never a stack of permanently-invisible `opacity:0` blocks (the trap a bare
 * `motion/react initial={{opacity:0}}` would set).
 *
 * After mount, an element that starts clearly below the fold is "armed" to the
 * hidden pre-state (`cp-reveal`), then an IntersectionObserver reveals it once
 * (`cp-reveal-in`). An element already in view at mount is never armed (no
 * hidden→shown snap for above-fold content). Reduced motion or no IO support →
 * never armed → stays visible.
 *
 * The default `HTMLDivElement` ref is assignable to a `<section>`'s `Ref<HTMLElement>`
 * (RefObject is covariant), so the same hook drives both element kinds.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>
  className: string
} {
  const ref = React.useRef<T>(null)
  const [phase, setPhase] = React.useState<'idle' | 'armed' | 'in'>('idle')

  React.useEffect(() => {
    const el = ref.current
    if (!el || typeof window === 'undefined') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce || !('IntersectionObserver' in window)) return
    // Arm only what starts clearly below the fold; in-view content renders solid
    // (no visible hidden→shown snap on the parts the visitor is already looking at).
    if (el.getBoundingClientRect().top < window.innerHeight * 0.85) return

    setPhase('armed')
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPhase('in')
          io.disconnect()
        }
      },
      // Fire when the element's top has risen into the lower ~20% of the viewport
      // (not the instant it peeks past the very bottom edge) — so the reveal plays
      // while the element is comfortably on screen, where the visitor sees it,
      // rather than settling unseen at the fold.
      { rootMargin: '0px 0px -20% 0px', threshold: 0.04 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return {
    ref,
    className: phase === 'idle' ? '' : phase === 'in' ? 'cp-reveal cp-reveal-in' : 'cp-reveal',
  }
}
