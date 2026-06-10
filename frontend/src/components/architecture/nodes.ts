import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'

// The system map as data (PORTAL §5.5). A curated, faithful subset of the spec's
// ASCII diagram — not a pixel-replica — laid out as vertical region bands plus a
// top owner row, in a 760×736 viewBox. The component maps live state onto these
// via `deriveNodeStatus`.

export type Region = 'owner' | 'triggers' | 'host' | 'container' | 'public'

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
  /** External documentation link for a third-party service we configure but don't own. */
  link?: string
  linkLabel?: string
  /** A human/external actor (e.g. the owner) — rendered with no status badge. */
  actor?: boolean
  /** Hosts a live interactive demo in its modal (a behavioral proof, NOT a health
   * probe — §24.35 Pass B). Drives the diagram's interactive marker. */
  demo?: 'sanitizer'
  x: number
  y: number
  w: number
  h: number
}

export interface ArchEdge {
  from: string
  to: string
  /** Genuinely duplex relationship (conversational channel / read-write store) → an arrowhead on both ends. */
  bidirectional?: boolean
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
  { region: 'triggers', label: 'TRIGGERS', x: 8, y: 92, w: 744, h: 84 },
  { region: 'host', label: 'HOST · Node', x: 8, y: 204, w: 744, h: 84 },
  { region: 'container', label: 'CONTAINER · Bun · per session', x: 8, y: 316, w: 744, h: 168 },
  { region: 'public', label: 'PUBLIC · sanitized read path', x: 8, y: 516, w: 744, h: 168 },
]

export const NODES: ArchNode[] = [
  // OWNER — the human in the loop. An actor, not a probed component → no badge.
  {
    id: 'owner',
    label: 'Jane Doe',
    region: 'owner',
    probe: 'structural',
    actor: true,
    description:
      'The candidate — the human in the loop. Drives the agent by chatting with it over Telegram, and reviews the drafts and approvals it sends back.',
    x: 25,
    y: 30,
    w: 164,
    h: NODE_H,
  },

  // TRIGGERS — external inputs; we don't probe them → structural.
  {
    id: 'trig-telegram',
    label: 'Telegram',
    region: 'triggers',
    probe: 'structural',
    description: 'The owner channel — a Telegram bot the candidate chats with; the agent replies back through it.',
    source: 'src/channels/adapter.ts',
    link: 'https://core.telegram.org/bots',
    linkLabel: 'Telegram Bot API',
    x: 25,
    y: 122,
    w: 164,
    h: NODE_H,
  },
  {
    id: 'trig-web',
    label: 'Web sandbox',
    region: 'triggers',
    probe: 'structural',
    description:
      'The public simulator — a visitor runs a sandboxed, isolated agent session from the portal and watches it stream.',
    source: 'src/channels/portal/adapter.ts',
    x: 207,
    y: 122,
    w: 164,
    h: NODE_H,
  },
  {
    id: 'trig-google',
    label: 'Gmail · Calendar',
    region: 'triggers',
    probe: 'structural',
    description:
      'Recruiter replies (Gmail) and interview events (Calendar) wake the system via close-detection; outreach drafts are written back through a Gmail tool.',
    link: 'https://developers.google.com/workspace',
    linkLabel: 'Google Workspace APIs',
    x: 389,
    y: 122,
    w: 164,
    h: NODE_H,
  },
  {
    id: 'trig-cron',
    label: 'Cron sweep',
    region: 'triggers',
    probe: 'structural',
    description: 'Periodic host sweep — due tasks, recurrence, and stale-application detection.',
    source: 'src/host-sweep.ts',
    x: 571,
    y: 122,
    w: 164,
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
    x: 162,
    y: 234,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'host-db',
    label: 'Session DB',
    region: 'host',
    probe: 'backend',
    description:
      'Per-session message store — inbound (host writes, container reads) and outbound (container writes, host reads + delivers).',
    source: 'src/db/session-db.ts',
    x: 410,
    y: 234,
    w: 188,
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
    x: 58,
    y: 346,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'cont-orch',
    label: 'Orchestrator',
    region: 'container',
    probe: 'sessions',
    description: 'The Claude Agent SDK loop. Healthy when at least one session is actively running.',
    source: 'src/providers/claude.ts',
    x: 286,
    y: 346,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'cont-subagents',
    label: 'Subagents',
    region: 'container',
    probe: 'structural',
    description:
      'research-company, tailor-resume, draft-outreach, build-interview-kit, scrape-jobs, pipeline-scribe — each makes its own LLM calls.',
    x: 514,
    y: 346,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'cont-portkey',
    label: 'Portkey gateway',
    region: 'container',
    probe: 'structural',
    description:
      "LLM gateway. Every model call from the container (orchestrator + subagents) routes through Portkey's Model Catalog → Anthropic — unified keys, fallback, and cost/latency analytics. A service we configure, not own; PORTKEY_BYPASS falls back to calling Anthropic directly.",
    link: 'https://portkey.ai/docs/product/model-catalog',
    linkLabel: 'Portkey Model Catalog',
    x: 162,
    y: 430,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'cont-anthropic',
    label: 'Anthropic API',
    region: 'container',
    probe: 'structural',
    description:
      'The Claude models behind the gateway (Opus / Sonnet / Haiku). External — every reasoning and tool-use turn is a call here.',
    link: 'https://docs.anthropic.com',
    linkLabel: 'Anthropic API docs',
    x: 410,
    y: 430,
    w: 188,
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
    demo: 'sanitizer',
    x: 58,
    y: 546,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'pub-audit',
    label: 'public_audit_trail',
    region: 'public',
    probe: 'backend',
    description: 'Append-only sanitized event log — the source for the live ticker and activity feed.',
    source: 'src/modules/portal/public-audit.ts',
    x: 286,
    y: 546,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'pub-api',
    label: 'Public API · SSE',
    region: 'public',
    probe: 'backend',
    description: 'Serves the read endpoints + the activity stream. This page got its data from here.',
    source: 'src/modules/portal/api.ts',
    x: 514,
    y: 546,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'pub-edge',
    label: 'Cloudflare edge',
    region: 'public',
    probe: 'structural',
    description:
      'Cloudflare Tunnel exposes the API (incl. SSE); a Worker serves this page from the edge. Infra we configure, not own.',
    link: 'https://developers.cloudflare.com',
    linkLabel: 'Cloudflare Workers + Tunnel',
    x: 286,
    y: 630,
    w: 188,
    h: NODE_H,
  },
]

export const EDGES: ArchEdge[] = [
  // Bidirectional = a genuinely duplex relationship: the conversational channels
  // (the agent replies back through them) and the read/write session store.
  { from: 'owner', to: 'trig-telegram', bidirectional: true },
  { from: 'trig-telegram', to: 'host-router', bidirectional: true },
  { from: 'trig-web', to: 'host-router', bidirectional: true },
  { from: 'trig-google', to: 'host-router' },
  { from: 'trig-cron', to: 'host-router' },
  { from: 'host-router', to: 'host-db', bidirectional: true },
  { from: 'host-router', to: 'cont-runtime' },
  { from: 'cont-runtime', to: 'cont-orch' },
  { from: 'cont-orch', to: 'cont-subagents' },
  { from: 'cont-orch', to: 'cont-portkey' },
  // Subagents make their own LLM calls; like the orchestrator they route through
  // the gateway (ANTHROPIC_BASE_URL is container-wide → Portkey → Anthropic).
  { from: 'cont-subagents', to: 'cont-portkey' },
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
