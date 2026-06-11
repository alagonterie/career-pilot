/**
 * Pure transform math for the /architecture diagram's scoped pinch-zoom
 * (STRATEGY §24.64). The component applies `translate(tx,ty) scale(s)` with
 * origin 0 0 to one layer holding both the SVG and the node-button overlay,
 * so tap targets track the zoom. Everything here is pure and unit-tested;
 * the gesture wiring (pointer events, touch-action flips) lives in
 * ArchDiagram.
 *
 * Coordinate model: container layout px, origin at the wrapper's top-left.
 * A content point c maps to screen p = t + s·c.
 */

export interface ZoomTransform {
  s: number
  tx: number
  ty: number
}

export const IDENTITY: ZoomTransform = { s: 1, tx: 0, ty: 0 }

export const MIN_SCALE = 1
export const MAX_SCALE = 3
/** At or below this, a gesture's end snaps back to identity — the diagram
 * returns to "just page content" and one-finger page scroll comes back. */
export const SNAP_SCALE = 1.05

export function isIdentity(t: ZoomTransform): boolean {
  return t.s === 1 && t.tx === 0 && t.ty === 0
}

/** Clamp scale to [1,3] and translate so the content always covers the
 * wrapper (no gutters): tx ∈ [w·(1−s), 0], same for ty. */
export function clampTransform(t: ZoomTransform, w: number, h: number): ZoomTransform {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.s))
  const tx = Math.min(0, Math.max(w * (1 - s), t.tx))
  const ty = Math.min(0, Math.max(h * (1 - s), t.ty))
  return { s, tx, ty }
}

/**
 * Pinch update. The gesture began at transform `t0` with midpoint (m0x,m0y)
 * and finger distance d0; the fingers are now at midpoint (mx,my), distance d.
 * The content point that was under the start midpoint stays under the current
 * midpoint (so the pinch both zooms about the fingers and pans with them),
 * then the result is clamped.
 */
export function pinchTransform(
  t0: ZoomTransform,
  m0x: number,
  m0y: number,
  d0: number,
  mx: number,
  my: number,
  d: number,
  w: number,
  h: number,
): ZoomTransform {
  const ratio = d0 > 0 ? d / d0 : 1
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t0.s * ratio))
  const cx = (m0x - t0.tx) / t0.s
  const cy = (m0y - t0.ty) / t0.s
  return clampTransform({ s, tx: mx - s * cx, ty: my - s * cy }, w, h)
}

/** One-finger pan while zoomed: shift by the finger delta, clamped. */
export function panTransform(t0: ZoomTransform, dx: number, dy: number, w: number, h: number): ZoomTransform {
  return clampTransform({ s: t0.s, tx: t0.tx + dx, ty: t0.ty + dy }, w, h)
}

/** Gesture-end settle: a near-1× scale snaps home to identity. */
export function settleTransform(t: ZoomTransform): ZoomTransform {
  return t.s <= SNAP_SCALE ? IDENTITY : t
}
