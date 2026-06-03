import { motion } from 'motion/react'
import * as React from 'react'

import { useDialog } from '~/lib/use-dialog'
import { repoBlob } from '~/lib/site'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'

import { SanitizerDemo } from './SanitizerDemo'
import { STATUS_META, type ArchNode, type NodeStatus } from './nodes'

const REGION_LABEL: Record<ArchNode['region'], string> = {
  owner: 'Owner',
  triggers: 'Triggers',
  host: 'Host · Node',
  container: 'Container · Bun',
  public: 'Public · sanitized',
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

/** The live facts we actually have for a probed node (none for structural). */
function nodeFacts(
  node: ArchNode,
  arch: ArchitectureData | null,
  mode: SystemMode | null,
): { label: string; value: string }[] {
  switch (node.probe) {
    case 'pause':
      return mode
        ? [
            { label: 'Mode', value: mode.live_mode ? 'LIVE' : 'SHADOW' },
            { label: 'Pause state', value: mode.pause_state },
          ]
        : []
    case 'backend':
      return [{ label: 'Backend', value: arch?.backend ?? '—' }]
    case 'container':
      return arch
        ? [
            { label: 'Runtime', value: arch.containers.runtime },
            { label: 'Running', value: `${arch.containers.running ?? '—'} / ${arch.containers.capacity_max}` },
            { label: 'Memory each', value: `${arch.containers.memory_mb_each} MB` },
          ]
        : []
    case 'sessions':
      return arch
        ? [
            { label: 'Sessions active', value: String(arch.sessions.active) },
            { label: 'Sessions running', value: String(arch.sessions.running) },
          ]
        : []
    default:
      return []
  }
}

/**
 * The node click-through modal (PORTAL §5.5), sharing the funnel drawer's
 * accessible-dialog contract via `useDialog` (PORTAL §8.5): labeled +
 * described, focus-trapped, Escape + backdrop close, focus restored to the
 * triggering node on close, the rest of the page held inert. Renders the node's
 * description + the live facts we actually probe + a line-anchored code link;
 * structural nodes carry the honest "no live probe" note. Recent log excerpts /
 * per-node calls are deferred (§24.28).
 */
export function NodePanel({
  node,
  status,
  arch,
  mode,
  onClose,
}: {
  node: ArchNode | null
  status: NodeStatus
  arch: ArchitectureData | null
  mode: SystemMode | null
  onClose: () => void
}) {
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  useDialog(node != null, onClose, panelRef, overlayRef)

  if (!node) return null

  const meta = STATUS_META[status]
  const structural = status === 'structural'
  const facts = nodeFacts(node, arch, mode)

  return (
    <div ref={overlayRef} className="fixed inset-0 z-30 flex items-center justify-center p-4">
      <motion.button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <motion.div
        layoutId={`arch-node-${node.id}`}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="arch-node-title"
        aria-describedby="arch-node-desc"
        data-testid="arch-node-panel"
        transition={{ layout: { duration: 0.2, ease: 'easeOut' } }}
        className="relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-xl focus:outline-none"
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { delay: 0.2, duration: 0.2 } }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          className="flex flex-col gap-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="arch-node-title" className="truncate font-mono text-lg font-semibold text-foreground">
                {node.label}
              </h2>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {REGION_LABEL[node.region]}
              </p>
              {node.actor ? null : node.demo ? (
                <p className="mt-2 flex items-center gap-2 font-mono text-xs">
                  <span aria-hidden="true" className="text-accent-cool">
                    ▶
                  </span>
                  <span className="text-foreground">Live demo</span>
                </p>
              ) : (
                <p className="mt-2 flex items-center gap-2 font-mono text-xs">
                  {structural ? (
                    <span aria-hidden="true">◇</span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2.5 w-2.5 rounded-full ${meta.dot.replace('fill-', 'bg-')}`}
                    />
                  )}
                  <span className={structural ? 'text-muted-foreground' : 'text-foreground'}>{meta.label}</span>
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="shrink-0 rounded-md border border-border px-2 py-1 font-mono text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Esc
            </button>
          </div>

          <p id="arch-node-desc" className="text-sm leading-relaxed text-foreground/90">
            {node.description}
          </p>

          {facts.length > 0 ? (
            <dl className="grid grid-cols-2 gap-4">
              {facts.map((f) => (
                <Fact key={f.label} label={f.label} value={f.value} />
              ))}
            </dl>
          ) : structural && !node.actor && !node.demo ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Drawn as structure — this node has no live health probe yet. Adding one (a Portkey health read,
              per-subagent activity, edge reachability) is deferred until the telemetry-capture work.
            </p>
          ) : null}

          {node.demo === 'sanitizer' ? <SanitizerDemo /> : null}

          {node.link || node.source ? (
            <div className="flex flex-col items-start gap-2">
              {node.link ? (
                <a
                  href={node.link}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-accent-cool hover:underline"
                >
                  {node.linkLabel ?? node.link} ↗
                </a>
              ) : null}
              {node.source ? (
                <a
                  href={repoBlob(node.source, node.sourceLine)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-accent-cool hover:underline"
                >
                  {node.source}
                  {node.sourceLine != null ? `:${node.sourceLine}` : ''} ↗
                </a>
              ) : null}
            </div>
          ) : null}

          {node.actor ? null : (
            <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
              Status badges light up only for nodes backed by a real probe; everything else is drawn as structure with
              no health claim.
            </p>
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
