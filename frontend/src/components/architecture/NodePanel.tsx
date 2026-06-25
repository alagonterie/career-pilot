import { motion, useReducedMotion } from 'motion/react'
import * as React from 'react'

import { AgentRef } from '~/components/AgentRef'
import { AI_ACTORS } from '~/lib/ai-actors'
import { useDialog } from '~/lib/use-dialog'
import { repoBlob } from '~/lib/site'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { Observability } from '~/lib/use-observability'

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

/** Humanize an age in seconds to a compact "just now / 3m / 2h / 5d". */
function fmtAge(sec: number): string {
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86_400)}d ago`
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

/** The live facts we actually have for a probed node (none for structural). */
function nodeFacts(
  node: ArchNode,
  arch: ArchitectureData | null,
  mode: SystemMode | null,
  obs: Observability | null,
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
    case 'sessions': {
      if (!arch) return []
      const facts = [
        { label: 'Sessions active', value: String(arch.sessions.active) },
        { label: 'Sessions running', value: String(arch.sessions.running) },
      ]
      // Session topology (§24.69 / §24.67) — the owner-chat vs autonomous-ops vs
      // public-sandbox split. Non-PII counts; enriches the Orchestrator modal.
      if (obs?.session_topology) {
        const t = obs.session_topology
        facts.push({ label: 'By class', value: `chat ${t.chat} · ops ${t.ops} · sandbox ${t.sandbox}` })
      }
      return facts
    }
    case 'provider': {
      if (obs == null) return []
      const present = (node.providers ?? [])
        .map((p) => obs.providers.find((x) => x.provider === p))
        .filter((p): p is NonNullable<typeof p> => p != null)
      if (present.length === 0) return []
      // Aggregate across this node's providers (§24.69 D-B — aggregate only).
      const requests = present.reduce((s, p) => s + p.requests_24h, 0)
      const errors = present.reduce((s, p) => s + p.errors_24h, 0)
      const ages = present.map((p) => p.last_success_age_sec).filter((n): n is number => n != null)
      const p50s = present.map((p) => p.p50_ms).filter((n): n is number => n != null)
      const facts = [
        { label: 'Requests 24h', value: String(requests) },
        { label: 'Error rate', value: `${Math.round((requests > 0 ? errors / requests : 0) * 100)}%` },
        { label: 'Last success', value: ages.length ? fmtAge(Math.min(...ages)) : '—' },
      ]
      if (p50s.length) facts.push({ label: 'p50 latency', value: fmtMs(Math.max(...p50s)) })
      return facts
    }
    case 'sandbox': {
      // §24.80: the public-demo kill switch + the day's spend against its budget.
      if (!arch?.sandbox) return []
      const s = arch.sandbox
      return [
        { label: 'Demo', value: s.enabled ? 'enabled' : 'disabled' },
        { label: 'Spend 24h', value: `$${s.spend_24h_usd.toFixed(2)} / $${s.daily_budget_usd.toFixed(2)}` },
      ]
    }
    case 'sweep':
      // §24.80: how long since the host sweep loop last completed a tick.
      if (!arch?.sweep) return []
      return [
        {
          label: 'Last sweep',
          value: arch.sweep.last_run_age_sec == null ? '—' : fmtAge(arch.sweep.last_run_age_sec),
        },
      ]
    default:
      return []
  }
}

/**
 * The node click-through modal (PORTAL §5.5), sharing the pipeline drawer's
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
  obs,
  onClose,
}: {
  node: ArchNode | null
  status: NodeStatus
  arch: ArchitectureData | null
  mode: SystemMode | null
  obs: Observability | null
  onClose: () => void
}) {
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  // §24.172: the content opacity fade below must honor reduced-motion. The root
  // `MotionConfig reducedMotion="user"` only suppresses transform/layout (the
  // `layoutId` grow), NOT opacity — so without this the content still fades in
  // for reduced-motion users, and an axe run that samples mid-fade reads every
  // (settled-AA-bright) token at ~35% opacity as a false contrast violation.
  const reduce = useReducedMotion()

  useDialog(node != null, onClose, panelRef, overlayRef)

  if (!node) return null

  const meta = STATUS_META[status]
  const structural = status === 'structural'
  // §24.80 D4: `idle` is the honest resting state (on-demand node with nothing
  // running, or a quiet probe), not a fault — say so in the modal so the grey
  // dot doesn't read like a warning.
  const idle = status === 'idle'
  const facts = nodeFacts(node, arch, mode, obs)

  return (
    <div ref={overlayRef} className="fixed inset-0 z-30 flex items-end justify-center p-0 sm:items-center sm:p-4">
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
        // A bottom-sheet on phones (full-width, rounded top, flush to the bottom
        // edge — §13); the centered max-w-lg card returns at `sm:` (desktop
        // baseline unchanged). The `layoutId` grow still animates from the node.
        className="relative z-10 max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-6 shadow-xl focus:outline-none sm:max-w-lg sm:rounded-lg"
      >
        <motion.div
          // Reduced motion: mount opaque (no fade) — `initial={false}` snaps to
          // the animate state. Otherwise fade in after the grow settles (§24.172).
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: reduce ? { duration: 0 } : { delay: 0.2, duration: 0.2 } }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          className="flex flex-col gap-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="arch-node-title" className="truncate font-mono text-lg font-semibold text-foreground">
                {node.ai ? (
                  <span aria-hidden="true" className="text-ai">
                    ✦{' '}
                  </span>
                ) : null}
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

          {/* §24.73: the Subagents node is where the cast is introduced — render
              the roster as tappable AgentRef chips so each name is explainable,
              consistent with how the cast appears everywhere else on the site. */}
          {node.id === 'cont-subagents' ? (
            <div data-testid="arch-cast" className="flex flex-col gap-2">
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Meet the cast</p>
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {AI_ACTORS.filter((a) => a.kind === 'subagent').map((a) => (
                  <li key={a.name}>
                    <AgentRef name={a.name} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {facts.length > 0 ? (
            <dl className="grid grid-cols-2 gap-4">
              {facts.map((f) => (
                <Fact key={f.label} label={f.label} value={f.value} />
              ))}
            </dl>
          ) : structural && !node.actor && !node.demo ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Drawn as structure — this node has no live health probe. The integration nodes we can observe (Portkey,
              the job API, Google Workspace, the gateway) now light up from request telemetry; the rest (the model API
              behind the gateway, per-subagent activity, edge reachability) stay honest structure with no health claim.
            </p>
          ) : null}

          {idle && !node.actor ? (
            <p data-testid="arch-idle-note" className="text-[11px] leading-relaxed text-muted-foreground">
              Idle means at rest right now — nothing running, not a fault. This node wakes on demand.
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
