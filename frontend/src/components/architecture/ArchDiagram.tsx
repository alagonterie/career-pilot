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
            <line
              key={`${e.from}-${e.to}`}
              x1={a.x + a.w / 2}
              y1={a.y + a.h}
              x2={b.x + b.w / 2}
              y2={b.y}
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
                <path d={diamond(n.x + n.w - 14, n.y + 14, 4)} className="fill-none stroke-muted-foreground/70" />
              ) : (
                <circle
                  cx={n.x + n.w - 14}
                  cy={n.y + 14}
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
