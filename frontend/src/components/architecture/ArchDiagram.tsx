import { motion } from 'motion/react'
import * as React from 'react'

import {
  IDENTITY,
  isIdentity,
  panTransform,
  pinchTransform,
  settleTransform,
  type ZoomTransform,
} from '~/lib/pinch-zoom'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { Observability } from '~/lib/use-observability'

import { EDGES, NODES, REGION_BANDS, STATUS_META, deriveNodeStatus, type ArchNode } from './nodes'

const VIEW_W = 760
const VIEW_H = 736

function nodeById(id: string): ArchNode | undefined {
  return NODES.find((n) => n.id === id)
}

function diamond(cx: number, cy: number, r: number): string {
  return `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`
}

// Targets fed by more than one cross-row edge (only Router today) fan their
// incoming arrowheads across the node's top instead of stacking on one point.
const INCOMING_TOP = EDGES.reduce<Record<string, string[]>>((acc, e) => {
  const a = nodeById(e.from)
  const b = nodeById(e.to)
  if (a && b && a.y !== b.y) (acc[e.to] ??= []).push(e.from)
  return acc
}, {})

function entryFraction(from: string, to: string): number {
  const sibs = INCOMING_TOP[to]
  if (!sibs || sibs.length <= 1) return 0.5
  return (sibs.indexOf(from) + 1) / (sibs.length + 1)
}

/**
 * Edge path between two nodes. Same-row siblings connect side-to-side (a clean
 * horizontal); cross-row/cross-band edges route as an orthogonal elbow. Usually
 * `from` (a) is the upper-or-same-row node and the elbow runs down → across →
 * down, with the horizontal leg just below the source (landing in the inter-band
 * gap, never riding a band border). When `from` is BELOW `to` (an upward edge —
 * e.g. the OneCLI gateway writing UP to Google Workspace, §24.111) the elbow is
 * mirrored: leave the source's top, leg just above it, arrive at the target's
 * bottom — otherwise the path would dip down then shoot a long line up across the
 * source's whole band. `entryFrac` distributes the arrowhead across the target
 * edge when several edges share a target.
 */
function edgePath(a: ArchNode, b: ArchNode, entryFrac = 0.5): string {
  if (a.y === b.y) {
    const y = a.y + a.h / 2
    const leftToRight = a.x < b.x
    const sx = leftToRight ? a.x + a.w : a.x
    const ex = leftToRight ? b.x : b.x + b.w
    return `M${sx} ${y} L${ex} ${y}`
  }
  const upward = a.y > b.y // a (the source) sits below b (the target)
  const sx = a.x + a.w / 2
  const sy = upward ? a.y : a.y + a.h // leave the top when heading up, else the bottom
  const ex = b.x + b.w * entryFrac
  const ey = upward ? b.y + b.h : b.y // arrive at the target's bottom when heading up, else its top
  const legY = sy + (upward ? -14 : 14)
  return `M${sx} ${sy} L${sx} ${legY} L${ex} ${legY} L${ex} ${ey}`
}

/**
 * The live system map (PORTAL §5.5). The SVG is purely visual (`aria-hidden`);
 * interaction rides on a transparent HTML `<button>` overlay positioned over
 * each node by percentage of the fixed viewBox — so every node is a real
 * keyboard-focusable button (axe-clean, free focus ring) without forcing a
 * `button` role onto SVG `<g>` elements. Status badges come from
 * `deriveNodeStatus`: a colored dot for probed nodes, a hollow diamond for
 * structural nodes (no health claim — §24.28).
 */
export function ArchDiagram({
  arch,
  mode,
  obs,
  selectedId,
  onSelect,
}: {
  arch: ArchitectureData | null
  mode: SystemMode | null
  obs: Observability | null
  selectedId: string | null
  onSelect: (node: ArchNode) => void
}) {
  // Scoped pinch-zoom (§24.64): one transform layer holds the SVG AND the
  // node-button overlay, so tap targets track the zoom. Gesture model:
  //   at rest  → touch-action: pan-y — one finger scrolls the page exactly as
  //              before, while a two-finger pinch is NOT a pan-y gesture, so
  //              the browser leaves it to these handlers (and doesn't zoom the
  //              page itself);
  //   zoomed   → touch-action: none — one finger pans the map (clamped), the
  //              reset chip is the way back to page scrolling.
  // Mouse/pen pointers are ignored — desktop behaves exactly as before.
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = React.useState<ZoomTransform>(IDENTITY)
  const zoomRef = React.useRef(zoom)
  zoomRef.current = zoom
  const pointers = React.useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = React.useRef<{ t: ZoomTransform; mx: number; my: number; d: number } | null>(null)
  // Total finger travel this gesture — a pan must not fire the node tap that
  // the browser synthesizes after pointerup (touch-action none keeps clicks
  // coming regardless of distance). Reset on the next gesture's first touch.
  const movedRef = React.useRef(0)

  const localPoint = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (pointers.current.size === 0) movedRef.current = 0
    pointers.current.set(e.pointerId, localPoint(e))
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchStart.current = {
        t: zoomRef.current,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        d: Math.hypot(a.x - b.x, a.y - b.y),
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const p = localPoint(e)
    movedRef.current += Math.hypot(p.x - prev.x, p.y - prev.y)
    pointers.current.set(e.pointerId, p)
    const ps = pinchStart.current
    if (pointers.current.size >= 2 && ps) {
      const [a, b] = [...pointers.current.values()]
      setZoom(
        pinchTransform(
          ps.t,
          ps.mx,
          ps.my,
          ps.d,
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          Math.hypot(a.x - b.x, a.y - b.y),
          p.w,
          p.h,
        ),
      )
    } else if (pointers.current.size === 1 && zoomRef.current.s > 1) {
      setZoom(panTransform(zoomRef.current, p.x - prev.x, p.y - prev.y, p.w, p.h))
    }
  }

  const onPointerEnd = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    if (pointers.current.size < 2 && pinchStart.current) {
      pinchStart.current = null
      setZoom((t) => settleTransform(t))
    }
  }

  const onClickCapture = (e: React.MouseEvent) => {
    if (movedRef.current > 8) {
      // Consume-once: eat only the click the browser synthesizes off this
      // gesture's pointerup, then clear — a later non-touch click (which never
      // hits onPointerDown's reset) must not inherit the stale travel.
      movedRef.current = 0
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden"
      style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}`, touchAction: zoom.s > 1 ? 'none' : 'pan-y' }}
      data-testid="arch-diagram"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={onClickCapture}
    >
      <div
        data-testid="arch-zoom-layer"
        className="absolute inset-0"
        style={
          isIdentity(zoom)
            ? undefined
            : { transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})`, transformOrigin: '0 0' }
        }
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <defs>
            <marker
              id="arch-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L8 4 L0 8 z" className="fill-muted-foreground" />
            </marker>
          </defs>

          {REGION_BANDS.map((b) => (
            <g key={b.region}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} className="fill-card/40 stroke-border" />
              <text
                x={b.x + 12}
                y={b.y + 18}
                className="fill-muted-foreground font-mono text-[10px] uppercase tracking-widest"
              >
                {b.label}
              </text>
            </g>
          ))}

          {/* Group opacity (not per-edge alpha) so where two legs overlap they
            composite opaque first, then the whole group fades once — no
            darker patches at crossings. */}
          <g opacity={0.3}>
            {EDGES.map((e) => {
              const a = nodeById(e.from)
              const b = nodeById(e.to)
              if (!a || !b) return null
              return (
                <path
                  key={`${e.from}-${e.to}`}
                  d={edgePath(a, b, entryFraction(e.from, e.to))}
                  fill="none"
                  className="stroke-muted-foreground"
                  markerStart={e.bidirectional ? 'url(#arch-arrow)' : undefined}
                  markerEnd="url(#arch-arrow)"
                />
              )
            })}
          </g>

          {NODES.map((n) => {
            const status = deriveNodeStatus(n, arch, mode, obs)
            const meta = STATUS_META[status]
            const actor = n.actor === true
            const structural = status === 'structural'
            return (
              <g key={n.id}>
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx={actor ? n.h / 2 : 6}
                  strokeWidth={1.5}
                  strokeDasharray={structural && !actor ? '4 3' : undefined}
                  className={[
                    actor ? 'fill-secondary' : structural ? 'fill-card/30' : 'fill-card',
                    selectedId === n.id ? 'stroke-primary' : 'stroke-border',
                  ].join(' ')}
                />
                <text
                  x={n.x + n.w / 2}
                  y={n.y + n.h / 2 + 4}
                  textAnchor="middle"
                  className={`font-mono text-[12px] ${structural && !actor ? 'fill-muted-foreground' : 'fill-foreground'}`}
                >
                  {/* §24.73: AI I built carries the ✦ provenance glyph (AI accent). */}
                  {n.ai ? <tspan className="fill-ai">✦ </tspan> : null}
                  {n.label}
                </text>
                {/* Demo nodes get an interactive ▶ (a behavioral proof, not a health probe — §24.35 Pass B);
                  actor (the human) no marker; probed nodes a colored dot; structural a hollow diamond. */}
                {n.demo ? (
                  <text
                    x={n.x + n.w - 16}
                    y={n.y + n.h / 2 + 3.5}
                    textAnchor="middle"
                    className="fill-accent-cool text-[10px]"
                  >
                    ▶
                  </text>
                ) : actor ? null : structural ? (
                  <path
                    d={diamond(n.x + n.w - 16, n.y + n.h / 2, 4)}
                    className="fill-none stroke-muted-foreground/70"
                  />
                ) : (
                  <circle
                    cx={n.x + n.w - 16}
                    cy={n.y + n.h / 2}
                    r={4.5}
                    className={`${meta.dot} ${meta.pulse ? 'cp-live-pulse' : ''}`}
                  />
                )}
              </g>
            )
          })}

          <text
            x={VIEW_W / 2}
            y={VIEW_H - 38}
            textAnchor="middle"
            className="fill-muted-foreground font-mono text-[11px]"
          >
            ▼ this page is served from the Cloudflare edge — you are here
          </text>
        </svg>

        {NODES.map((n) => {
          const status = deriveNodeStatus(n, arch, mode, obs)
          return (
            <motion.button
              key={n.id}
              type="button"
              layoutId={`arch-node-${n.id}`}
              data-testid={`arch-node-${n.id}`}
              data-status={n.actor ? 'actor' : status}
              aria-label={n.actor ? n.label : `${n.label} — ${STATUS_META[status].label}`}
              onClick={() => onSelect(n)}
              // On a phone the diagram scales down to ~45%, so a node box is only
              // ~21px tall — below a comfortable tap target (§13). Float each
              // (invisible) overlay button to a ≥44px hit area, roughly centered on
              // its node via a negative margin (not a transform — that would clash
              // with motion's `layoutId` grow). Desktop is exact (`sm:` resets).
              className="absolute -mt-3 min-h-[44px] rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:mt-0 sm:min-h-0"
              style={{
                left: `${(n.x / VIEW_W) * 100}%`,
                top: `${(n.y / VIEW_H) * 100}%`,
                width: `${(n.w / VIEW_W) * 100}%`,
                height: `${(n.h / VIEW_H) * 100}%`,
              }}
            />
          )
        })}
      </div>

      {/* The honest exit while zoomed — also the way back to one-finger page
          scrolling (the wrapper is touch-action:none at s>1). */}
      {zoom.s > 1 ? (
        <button
          type="button"
          data-testid="arch-zoom-reset"
          onClick={() => setZoom(IDENTITY)}
          className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 px-2 py-1 font-mono text-xs text-foreground shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ⤺ Reset zoom
        </button>
      ) : null}
    </div>
  )
}
