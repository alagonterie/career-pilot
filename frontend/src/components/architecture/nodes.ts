import { PERSON_NAME, REPO_URL } from '~/lib/site'
import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { Observability } from '~/lib/use-observability'

// The system map as data (PORTAL §5.5). A curated, faithful subset of the spec's
// ASCII diagram — not a pixel-replica — laid out as vertical region bands plus a
// top owner row, in a 760×736 viewBox. The component maps live state onto these
// via `deriveNodeStatus`.

export type Region = 'owner' | 'triggers' | 'host' | 'container' | 'public'

/** What real signal (if any) backs a node's status badge. `structural` nodes get
 * no health claim — we never paint a color we don't actually probe (§24.24).
 * `provider` reads per-provider health from request_telemetry (§24.69).
 * `sandbox`/`sweep` are the §24.80 promotions: the public-demo kill switch + 24h
 * spend-vs-cap, and the host sweep loop's freshness. */
export type ProbeKind = 'structural' | 'pause' | 'backend' | 'container' | 'sessions' | 'provider' | 'sandbox' | 'sweep'

export type NodeStatus = 'healthy' | 'degraded' | 'down' | 'idle' | 'structural'

export interface ArchNode {
  id: string
  label: string
  region: Region
  probe: ProbeKind
  /** For probe: 'provider' — the request_telemetry provider slugs this node maps to (§24.69). */
  providers?: string[]
  /** How to fold multiple providers into one status: 'worst' (default — any down
   * ⇒ down) or 'gateway' (down only when EVERY present provider is down — the
   * OneCLI shape: one service failing is that service's problem, not the gateway's). */
  providerAggregate?: 'worst' | 'gateway'
  description: string
  /** Repo-relative source path for the line-anchored code link (omitted when none applies). */
  source?: string
  sourceLine?: number
  /** External documentation link for a third-party service we configure but don't own. */
  link?: string
  linkLabel?: string
  /** A human/external actor (e.g. the owner) — rendered with no status badge. */
  actor?: boolean
  /** AI I built (the orchestrator, the subagents) — gets the ✦ provenance glyph
   *  (§24.73) before its name, in the AI accent. */
  ai?: boolean
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
    label: PERSON_NAME,
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
    source: 'src/channels/telegram.ts',
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
    probe: 'sandbox',
    description:
      'The public "Watch it work" surface — a visitor runs a sandboxed, isolated agent session from the portal and watches it stream. Status tracks the kill switch and the day’s sandbox spend against its daily budget: degraded once the cap is reached, idle when nobody’s run it.',
    source: 'src/channels/portal/adapter.ts',
    x: 207,
    y: 122,
    w: 164,
    h: NODE_H,
  },
  {
    id: 'trig-google',
    label: 'Google Workspace',
    region: 'triggers',
    probe: 'provider',
    providers: ['gmail', 'calendar', 'drive'],
    description:
      'Recruiter replies (Gmail) and interview events (Calendar) wake the system — a polling close-detection loop, not webhooks. The agent writes back too: reversible Gmail drafts, and interview-prep kit Docs in the candidate’s own Drive.',
    source: 'src/modules/career-pilot/close-detection-bootstrap.ts',
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
    probe: 'sweep',
    description:
      'Periodic host sweep (every 60s) — delivers due scheduled work (the morning briefing, the pipeline sweep), advances recurring tasks, and recovers stuck containers. Healthy when the loop is ticking; some work is deferred by design (quiet hours), which is not a fault — the deep "did a job get missed" check lives in the operator health runbook.',
    source: 'src/host-sweep.ts',
    x: 571,
    y: 122,
    w: 164,
    h: NODE_H,
  },

  // HOST — the long-running Node process.
  {
    id: 'host-db',
    label: 'Session DB',
    region: 'host',
    probe: 'backend',
    description:
      'Per-session message store — inbound (host writes, container reads) and outbound (container writes, host reads + delivers).',
    source: 'src/db/session-db.ts',
    x: 58,
    y: 234,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'host-router',
    label: 'Router · Sweep',
    region: 'host',
    probe: 'pause',
    description: 'Routes inbound messages and runs the sweep loop. Status tracks the pause-state ladder.',
    source: 'src/router.ts',
    x: 286,
    y: 234,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'host-onecli',
    label: 'OneCLI gateway',
    region: 'host',
    probe: 'provider',
    // Every credential-injected provider rides this proxy; it's only "down" when
    // EVERYthing through it is failing (one dead service is that service's node).
    providers: ['gmail', 'calendar', 'drive', 'serpapi', 'greenhouse', 'lever', 'portkey'],
    providerAggregate: 'gateway',
    description:
      'The credential perimeter — inherited with the NanoClaw fork and kept. Every outbound HTTPS call a container makes rides this proxy, and the real secrets (the Portkey key, the job-search API key, Google OAuth tokens) are injected on the wire. A container never holds a real credential.',
    link: 'https://github.com/onecli/onecli',
    linkLabel: 'OneCLI on GitHub',
    x: 514,
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
    ai: true,
    region: 'container',
    probe: 'sessions',
    description: 'The Claude Agent SDK loop. Healthy when at least one session is actively running.',
    // NOT the host's same-named src/providers/claude.ts (that file is the
    // Portkey provider *config*) — the loop lives in the agent-runner tree.
    source: 'container/agent-runner/src/providers/claude.ts',
    x: 286,
    y: 346,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'cont-subagents',
    label: 'Subagents',
    ai: true,
    region: 'container',
    probe: 'structural',
    description: 'Six specialists the orchestrator dispatches, each making its own LLM calls — meet them below.',
    link: `${REPO_URL}/tree/master/groups/career-pilot/.claude/agents-src`,
    linkLabel: 'Agent definitions (repo)',
    x: 514,
    y: 346,
    w: 188,
    h: NODE_H,
  },
  {
    id: 'cont-portkey',
    label: 'Portkey gateway',
    region: 'container',
    probe: 'provider',
    providers: ['portkey'],
    description:
      "LLM gateway. Every model call routes through Portkey's Model Catalog → Anthropic: the orchestrator and subagents in the container, and the host's own calls (the sanitizer's semantic pass, win-confidence scoring). Unified keys, fallback, cost/latency traces. A service we configure, not own; a bypass env falls back to calling Anthropic directly.",
    link: 'https://portkey.ai/docs/product/model-catalog',
    linkLabel: 'Portkey Model Catalog',
    x: 162,
    y: 430,
    w: 164,
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
    x: 360,
    y: 430,
    w: 164,
    h: NODE_H,
  },
  {
    id: 'cont-jobs',
    label: 'Job search API',
    region: 'container',
    probe: 'provider',
    providers: ['serpapi', 'greenhouse', 'lever'],
    description:
      'A commercial Google-Jobs search index. The scrape-jobs subagent queries it for live postings, which land in the job-leads pool the orchestrator continuously re-reads while scouting. Not an LLM call — a plain HTTPS fetch, with the API key injected in flight by the OneCLI gateway.',
    source: 'container/agent-runner/src/mcp-tools/scrape-jobs.ts',
    x: 558,
    y: 430,
    w: 164,
    h: NODE_H,
  },

  // PUBLIC — the sanitized, read-only path that feeds this page.
  {
    id: 'pub-sanitize',
    label: 'Sanitization',
    region: 'public',
    probe: 'structural',
    description:
      'Three passes before anything reaches a public table: deterministic PII scrubbing, company-name obfuscation, then an LLM semantic pass that genericizes products and events. The fail-safe is withhold — a line that can’t be sanitized is never published.',
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
    description:
      'Append-only sanitized event log with a monotonic cursor — the source for the live ticker and the activity feed, resumable mid-stream after a dropped connection.',
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
      'The browser talks only to the Worker: it serves this page from the edge and proxies every /api/* call — JSON and the live SSE stream — through an Access-gated Cloudflare Tunnel to the host, authenticating with a service token. Infra we configure, not own.',
    source: 'frontend/src/routes/api/$.ts',
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
  // The egress proxy is duplex by nature — containers call out through it and
  // credentials come back injected in flight. Drawn to the runtime because the
  // runtime is what wires each spawned container through the gateway.
  { from: 'host-onecli', to: 'cont-runtime', bidirectional: true },
  { from: 'cont-runtime', to: 'cont-orch' },
  { from: 'cont-orch', to: 'cont-subagents' },
  { from: 'cont-orch', to: 'cont-portkey' },
  // Subagents make their own LLM calls; like the orchestrator they route through
  // the gateway (ANTHROPIC_BASE_URL is container-wide → Portkey → Anthropic).
  { from: 'cont-subagents', to: 'cont-portkey' },
  { from: 'cont-portkey', to: 'cont-anthropic' },
  // Not an LLM path: scrape-jobs fetches the jobs index directly (OneCLI
  // injects the key on the wire).
  { from: 'cont-subagents', to: 'cont-jobs' },
  { from: 'cont-orch', to: 'pub-sanitize' },
  { from: 'pub-sanitize', to: 'pub-audit' },
  { from: 'pub-audit', to: 'pub-api' },
  { from: 'pub-api', to: 'pub-edge' },
]

/**
 * Fold a provider-node's mapped providers into one status (§24.69). Providers
 * absent from the window contribute nothing; a node with NO present provider
 * reads `idle` (honest — no recent call, no claim). `worst` (default) takes the
 * worst present status; `gateway` only reports `down` when EVERY present
 * provider is down (the OneCLI-perimeter shape).
 */
function deriveProviderStatus(node: ArchNode, obs: Observability | null): NodeStatus {
  if (obs == null) return 'idle'
  const present = (node.providers ?? [])
    .map((p) => obs.providers.find((x) => x.provider === p))
    .filter((p): p is NonNullable<typeof p> => p != null)
  if (present.length === 0) return 'idle'
  if (node.providerAggregate === 'gateway') {
    if (present.every((p) => p.status === 'down')) return 'down'
    return present.some((p) => p.status !== 'healthy') ? 'degraded' : 'healthy'
  }
  if (present.some((p) => p.status === 'down')) return 'down'
  if (present.some((p) => p.status === 'degraded')) return 'degraded'
  return 'healthy'
}

/**
 * The honesty core (§24.28). A node's badge lights up only from a real probe;
 * `structural` nodes always return `structural` (rendered with no health claim).
 * When `arch`/`mode`/`obs` is still null (cold load), live probes read as `idle`
 * rather than asserting a red "down" — the diagram only renders once `arch` is
 * present, so this is the safe transient.
 */
export function deriveNodeStatus(
  node: ArchNode,
  arch: ArchitectureData | null,
  mode: SystemMode | null,
  obs: Observability | null,
): NodeStatus {
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
    case 'provider':
      return deriveProviderStatus(node, obs)
    case 'sandbox': {
      // §24.80: the public-demo health. `down` when the kill switch is off;
      // `degraded` once the day's sandbox spend reaches its budget; `idle` when
      // it's enabled but nobody has run it (no spend) — the honest resting state.
      const s = arch?.sandbox
      if (s == null) return 'idle'
      if (!s.enabled) return 'down'
      if (s.daily_budget_usd > 0 && s.spend_24h_usd >= s.daily_budget_usd) return 'degraded'
      if (s.spend_24h_usd <= 0) return 'idle'
      return 'healthy'
    }
    case 'sweep': {
      // §24.80: the host sweep loop's freshness. `idle` before the first tick
      // (cold) or on an older backend; `healthy` while the loop is ticking;
      // `down` once it's gone silent past the staleness threshold (`fresh`).
      const w = arch?.sweep
      if (w == null || w.last_run_age_sec == null) return 'idle'
      return w.fresh ? 'healthy' : 'down'
    }
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
