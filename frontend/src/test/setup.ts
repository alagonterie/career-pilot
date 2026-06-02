import '@testing-library/jest-dom/vitest'

// jsdom has no matchMedia; motion/react's `MotionConfig reducedMotion="user"`
// (the funnel board) reads it. Standard no-op shim so component tests that
// render motion elements don't crash. Reports "no preference" (animations on),
// which is irrelevant in jsdom since nothing actually animates.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
