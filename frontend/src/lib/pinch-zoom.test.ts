import { describe, expect, it } from 'vitest'

import {
  IDENTITY,
  MAX_SCALE,
  clampTransform,
  isIdentity,
  panTransform,
  pinchTransform,
  settleTransform,
} from './pinch-zoom'

// A phone-ish wrapper: 360 wide, the diagram's 760:736 aspect.
const W = 360
const H = 348

describe('pinch-zoom math (§24.64)', () => {
  it('clamps scale to [1, 3]', () => {
    expect(clampTransform({ s: 0.5, tx: 0, ty: 0 }, W, H).s).toBe(1)
    expect(clampTransform({ s: 9, tx: 0, ty: 0 }, W, H).s).toBe(MAX_SCALE)
  })

  it('clamps translate so the content always covers the wrapper (no gutters)', () => {
    // At 2x the content is 720 wide; valid tx ∈ [-360, 0].
    expect(clampTransform({ s: 2, tx: 50, ty: 50 }, W, H)).toEqual({ s: 2, tx: 0, ty: 0 })
    expect(clampTransform({ s: 2, tx: -9999, ty: -9999 }, W, H)).toEqual({ s: 2, tx: -W, ty: -H })
  })

  it('pinch zooms about the fingers: the content under the start midpoint stays under them', () => {
    // Fingers centered at the wrapper middle, doubling their distance from identity.
    const t = pinchTransform(IDENTITY, W / 2, H / 2, 100, W / 2, H / 2, 200, W, H)
    expect(t.s).toBe(2)
    // Content point (W/2, H/2) must still render at (W/2, H/2): t + s·c = m.
    expect(t.tx + t.s * (W / 2)).toBeCloseTo(W / 2)
    expect(t.ty + t.s * (H / 2)).toBeCloseTo(H / 2)
  })

  it('pinch pans with a moving midpoint (two-finger drag), still clamped', () => {
    const start = pinchTransform(IDENTITY, W / 2, H / 2, 100, W / 2, H / 2, 200, W, H)
    // Same distance (no scale change), midpoint dragged right by 40 → content
    // shifts right, clamped at tx=0 max.
    const dragged = pinchTransform(start, W / 2, H / 2, 100, W / 2 + 40, H / 2, 100, W, H)
    expect(dragged.s).toBe(start.s)
    expect(dragged.tx).toBe(Math.min(0, start.tx + 40))
  })

  it('one-finger pan shifts by the delta and clamps at the edges', () => {
    const zoomed = { s: 2, tx: -100, ty: -100 }
    expect(panTransform(zoomed, 30, -10, W, H)).toEqual({ s: 2, tx: -70, ty: -110 })
    expect(panTransform(zoomed, 9999, 9999, W, H)).toEqual({ s: 2, tx: 0, ty: 0 })
  })

  it('settle snaps a near-1x gesture home to identity, leaves real zoom alone', () => {
    expect(settleTransform({ s: 1.04, tx: -3, ty: -2 })).toEqual(IDENTITY)
    const zoomed = { s: 1.6, tx: -50, ty: -40 }
    expect(settleTransform(zoomed)).toEqual(zoomed)
    expect(isIdentity(settleTransform({ s: 1.0, tx: 0, ty: 0 }))).toBe(true)
  })

  it('a zero start distance cannot divide-by-zero the scale', () => {
    const t = pinchTransform(IDENTITY, 10, 10, 0, 20, 20, 50, W, H)
    expect(t.s).toBe(1)
  })
})
