import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'

// The system map as data (PORTAL §5.5). A curated, faithful subset of the spec's
// ASCII diagram — not a pixel-replica — laid out as vertical region bands in a
// 760×700 viewBox. The component maps live state onto these via `deriveNodeStatus`.

export type Region = 'triggers' | 'host' | 'container' | 'public'

/** What real signal (if any) backs a node's status badge. `structural` nodes get
 * no health claim — we never paint a color we don't actually probe (§24.24). */
export type ProbeKind = 'structural' | 'pause' | 'backend' | 'container' | 'sessions'

export type NodeStatus = 'healthy' | 'degraded' | 'down' | 'idle' | 'structural'

export interface ArchNode {
  id: string
  label: string
  region: Region
  probe: ProbeKind
  description: string
  /** Repo-relative source path for the line-anchored code link (omitted when none applies). */
  source?: string
  sourceLine?: number
  x: number
  y: number
  w: number
  h: number
}

export interface ArchEdge {
  from: string
  to: string
}

export interface RegionBand {
  region: Region
  label: string
  x: number
  y: number
  w: number
  h: number
}

const NODE_H = 46

export const REGION_BANDS: RegionBand[] = [
  { region: 'triggers', label: 'TRIGGERS', x: 8, y: 16, w: 744, h: 84 },
  { region: 'host', label: 'HOST · Node', x: 8, y: 128, w: 744, h: 84 },
  { region: 'container', label: 'CONTAINER · Bun · per session', x: 8, y: 240, w: 744, h: 168 },
  { region: 'public', label: 'PUBLIC · sanitized read path', x: 8, y: 440, w: 744, h: 168 },
]

export const NODES: ArchNode[] = [
  // TRIGGERS — all external inputs; we don't probe them → structural.
  {
    id: 'trig-telegram',
    label: 'Telegram',
    region: 'triggers',
    probe: 'structural',
    description: 'Owner channel — the candidate chats with the orchestrator directly.',
    source: 'src/channels/adapter.ts',
    x: 24,
    y: 36,
    w: 160,
    h: NODE_H,
  },
  {
    id: 'trig-web',
    label: 'Web sandbox',
    region: 'triggers',
    probe: 'structural',
    description: 'Public simulator — visitors run a sandboxed agent from the portal.',
    source: 'src/channels/portal/adapter.ts',
    x: 204,
    y: 36,
    w: 160,
    h: NODE_H,
  },
  {
    id: 'trig-google',
    label: 'Gmail · Calendar',
    region: 'triggers',
    probe: 'structural',
    description: 'Recruiter replies and interview events wake the system (close-detection).',
    x: 384,
    y: 36,
    w: 168,
    h: NODE_H,
  },
  {
    id: 'trig-cron',
    label: 'Cron sweep',
    region: 'triggers',
    probe: 'structural',
    description: 'Periodic sweep — due tasks, recurrence, stale-application detection.',
    source: 'src/host-sweep.ts',
    x: 572,
    y: 36,
    w: 160,
    h: NODE_H,
  },

  // HOST — the long-running Node process.
  {
    id: 'host-router',
    label: 'Router · Sweep',
    region: 'host',
    probe: 'pause',
    description: 'Routes inbound messages and runs the sweep loop. Status tracks the pause-state ladder.',
    source: 'src/router.ts',
    x: 170,
    y: 148,
    w: 200,
    h: NODE_H,
  },
  {
    id: 'host-db',
    label: 'Session DB',
    region: 'host',
    probe: 'backend',
    description: 'Per-session inbound/outbound message store on the host.',
    source: 'src/db/session-db.ts',
    x: 410,
    y: 148,
    w: 180,
    h: NODE_H,
  },

  // CONTAINER — one isolated Bun container per session.
  {
    id: 'cont-runtime',
    label: 'Container runtime',
    region: 'container',
    probe: 'container',
    description: 'Spawns the per-session container. Status tracks the runtime + the running-count vs capacity.',
    source: 'src/container-runner.ts',
    x: 70,
    y: 258,
    w: 190,
    h: NODE_H,
  },
  {
    id: 'cont-orch',
    label: 'Orchestrator',
    region: 'container',
    probe: 'sessions',
    description: 'The Claude Agent SDK loop. Healthy when at least one session is actively running.',
    source: 'src/providers/claude.ts',
    x: 290,
    y: 258,
    w: 180,
    h: NODE_H,
  },
  {
    id: 'cont-subagents',
    label: 'Subagents',
    region: 'container',
    probe: 'structural',
    description: 'research-company, tailor-resume, draft-outreach, prep-interview, scrape-jobs, funnel-curator.',
    x: 500,
    y: 258,
    w: 190,
    h: NODE_H,
  },
  {
    id: 'cont-portkey',
    label: 'Portkey gateway',
    region: 'container',
    probe: 'structural',
    description: 'LLM gateway — model catalog + fallback. No live health probe yet (deferred to telemetry).',
    x: 180,
    y: 330,
    w: 190,
    h: NODE_H,
  },
  {
    id: 'cont-anthropic',
    label: 'Anthropic API',
    region: 'container',
    probe: 'structural',
    description: 'The Claude models behind the gateway. External — no direct probe.',
    x: 410,
    y: 330,
    w: 190,
    h: NODE_H,
  },

  // PUBLIC — the sanitized, read-only path that feeds this page.
  {
    id: 'pub-sanitize',
    label: 'Sanitization',
    region: 'public',
    probe: 'structural',
    description: 'Strips PII and obfuscates companies before anything reaches the public tables.',
    source: 'src/modules/portal/sanitizer.ts',
    x: 70,
    y: 458,
    w: 170,
    h: NODE_H,
  },
  {
    id: 'pub-audit',
    label: 'public_audit_trail',
    region: 'public',
    probe: 'backend',
    description: 'Append-only sanitized event log — the source for the live ticker and activity feed.',
    source: 'src/modules/portal/public-audit.ts',
    x: 270,
    y: 458,
    w: 200,
    h: NODE_H,
  },
  {
    id: 'pub-api',
    label: 'Public API · SSE',
    region: 'public',
    probe: 'backend',
    description: 'Serves the read endpoints + the activity stream. This page got its data from here.',
    source: 'src/modules/portal/api.ts',
    x: 500,
    y: 458,
    w: 190,
    h: NODE_H,
  },
  {
    id: 'pub-edge',
    label: 'Cloudflare edge',
    region: 'public',
    probe: 'structural',
    description: 'Tunnel + Worker — serves this page from the edge. Infra, no in-app probe.',
    x: 290,
    y: 530,
    w: 180,
    h: NODE_H,
  },
]

export const EDGES: ArchEdge[] = [
  { from: 'trig-telegram', to: 'host-router' },
  { from: 'trig-web', to: 'host-router' },
  { from: 'trig-google', to: 'host-router' },
  { from: 'trig-cron', to: 'host-router' },
  { from: 'host-router', to: 'host-db' },
  { from: 'host-router', to: 'cont-runtime' },
  { from: 'cont-runtime', to: 'cont-orch' },
  { from: 'cont-orch', to: 'cont-subagents' },
  { from: 'cont-orch', to: 'cont-portkey' },
  { from: 'cont-portkey', to: 'cont-anthropic' },
  { from: 'cont-orch', to: 'pub-sanitize' },
  { from: 'pub-sanitize', to: 'pub-audit' },
  { from: 'pub-audit', to: 'pub-api' },
  { from: 'pub-api', to: 'pub-edge' },
]

/**
 * The honesty core (§24.28). A node's badge lights up only from a real probe;
 * `structural` nodes always return `structural` (rendered with no health claim).
 * When `arch`/`mode` is still null (cold load), live probes read as `idle`
 * rather than asserting a red "down" — the diagram only renders once `arch` is
 * present, so this is the safe transient.
 */
export function deriveNodeStatus(node: ArchNode, arch: ArchitectureData | null, mode: SystemMode | null): NodeStatus {
  switch (node.probe) {
    case 'structural':
      return 'structural'
    case 'pause': {
      const p = mode?.pause_state
      if (p == null) return 'idle'
      if (p === 'active') return 'healthy'
      if (p === 'paused') return 'degraded'
      return 'down' // halted | killswitch
    }
    case 'backend':
      if (arch == null) return 'idle'
      return arch.backend === 'online' ? 'healthy' : 'down'
    case 'container': {
      const c = arch?.containers
      if (c == null) return 'idle'
      if (c.runtime === 'down') return 'down'
      return (c.running ?? 0) > 0 ? 'healthy' : 'idle'
    }
    case 'sessions':
      return (arch?.sessions.running ?? 0) > 0 ? 'healthy' : 'idle'
  }
}

export interface StatusMeta {
  label: string
  /** Tailwind fill utility for the status dot; empty for structural (no dot). */
  dot: string
  /** Reduced-motion-safe pulse (reuses the .cp-live-pulse class). */
  pulse: boolean
}

export const STATUS_META: Record<NodeStatus, StatusMeta> = {
  healthy: { label: 'Healthy', dot: 'fill-primary', pulse: true },
  degraded: { label: 'Degraded', dot: 'fill-warn', pulse: false },
  down: { label: 'Down', dot: 'fill-destructive', pulse: false },
  idle: { label: 'Idle', dot: 'fill-muted-foreground', pulse: false },
  structural: { label: 'Structural — no live probe', dot: '', pulse: false },
}
