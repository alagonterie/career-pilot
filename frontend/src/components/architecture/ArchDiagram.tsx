import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'

import { EDGES, NODES, REGION_BANDS, STATUS_META, deriveNodeStatus, type ArchNode } from './nodes'

const VIEW_W = 760
const VIEW_H = 660

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
 * horizontal); cross-row/cross-band edges route as an orthogonal elbow
 * (down → across → down). `from` (a) is always the upper-or-same-row node. The
 * horizontal leg sits just below the source so it lands in the inter-band gap
 * (never riding a band border), and `entryFrac` distributes the arrowhead
 * across the target's top when several edges share a target.
 */
function edgePath(a: ArchNode, b: ArchNode, entryFrac = 0.5): string {
  if (a.y === b.y) {
    const y = a.y + a.h / 2
    const leftToRight = a.x < b.x
    const sx = leftToRight ? a.x + a.w : a.x
    const ex = leftToRight ? b.x : b.x + b.w
    return `M${sx} ${y} L${ex} ${y}`
  }
  const sx = a.x + a.w / 2
  const sy = a.y + a.h
  const ex = b.x + b.w * entryFrac
  const ey = b.y
  const legY = sy + 14
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
  selectedId,
  onSelect,
}: {
  arch: ArchitectureData | null
  mode: SystemMode | null
  selectedId: string | null
  onSelect: (node: ArchNode) => void
}) {
  return (
    <div className="relative w-full" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }} data-testid="arch-diagram">
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
            <path d="M0 0 L8 4 L0 8 z" className="fill-muted-foreground/50" />
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

        {EDGES.map((e) => {
          const a = nodeById(e.from)
          const b = nodeById(e.to)
          if (!a || !b) return null
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={edgePath(a, b, entryFraction(e.from, e.to))}
              fill="none"
              className="stroke-muted-foreground/30"
              markerEnd="url(#arch-arrow)"
            />
          )
        })}

        {NODES.map((n) => {
          const status = deriveNodeStatus(n, arch, mode)
          const meta = STATUS_META[status]
          const structural = status === 'structural'
          return (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={6}
                strokeWidth={1.5}
                strokeDasharray={structural ? '4 3' : undefined}
                className={[
                  structural ? 'fill-card/30' : 'fill-card',
                  selectedId === n.id ? 'stroke-primary' : 'stroke-border',
                ].join(' ')}
              />
              <text
                x={n.x + n.w / 2}
                y={n.y + n.h / 2 + 4}
                textAnchor="middle"
                className={`font-mono text-[12px] ${structural ? 'fill-muted-foreground' : 'fill-foreground'}`}
              >
                {n.label}
              </text>
              {structural ? (
                <path d={diamond(n.x + n.w - 16, n.y + n.h / 2, 4)} className="fill-none stroke-muted-foreground/70" />
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

        <text x={VIEW_W / 2} y={622} textAnchor="middle" className="fill-muted-foreground font-mono text-[11px]">
          ▼ this page is served from the Cloudflare edge — you are here
        </text>
      </svg>

      {NODES.map((n) => {
        const status = deriveNodeStatus(n, arch, mode)
        return (
          <button
            key={n.id}
            type="button"
            data-testid={`arch-node-${n.id}`}
            data-status={status}
            aria-label={`${n.label} — ${STATUS_META[status].label}`}
            onClick={() => onSelect(n)}
            className="absolute rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  )
}
