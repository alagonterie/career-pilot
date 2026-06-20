/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getConfig } from './get-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  /**
   * Per-spawn env overrides — applied AFTER OneCLI's gateway env, so these
   * win on conflict. Used by the Ollama test mode to redirect Anthropic SDK
   * traffic to a local Ollama daemon. See add-ollama-provider skill steps
   * 1a/1b and the OLLAMA_TEST_MODE branch in `materializeContainerJson`.
   */
  env?: Record<string, string>;
  /**
   * Hosts to resolve to 0.0.0.0 inside the container (defense-in-depth
   * block on outbound to specific upstreams). Used by Ollama test mode to
   * prevent any accidental fall-through to `api.anthropic.com` when the
   * agent is supposed to be running against local Ollama.
   */
  blockedHosts?: string[];
  /**
   * Tools to remove from the agent's SDK context via the Agent SDK's
   * `disallowedTools` option (mcp__<server>__<name> form or SDK
   * built-in names). Concatenated with the static SDK_DISALLOWED_TOOLS
   * list at provider construction time. Per-group SDK-level isolation —
   * see container/agent-runner/src/providers/claude.ts and migration 109.
   */
  disallowedTools?: string[];
  /**
   * Emit simulator trace events (tool/subagent/cost) for the live activity
   * pane. Derived (not stored) — true only for the career-pilot-sandbox folder.
   * The provider gates trace emission on this; the owner group's stream stays
   * byte-identical. See STRATEGY.md §24.20.
   */
  emitTrace?: boolean;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    disallowedTools: parseDisallowedTools(row.disallowed_tools),
    // Sandbox-only simulator trace (§24.20) — derived from the folder, not a
    // stored column. The owner group never emits trace events.
    emitTrace: group.folder === 'career-pilot-sandbox',
  };
}

/** Parse the JSON-array text column; tolerate missing/legacy rows (pre-109). */
function parseDisallowedTools(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const tools = parsed.filter((x): x is string => typeof x === 'string');
    return tools.length > 0 ? tools : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 *
 * **Ollama test-mode override:** when `OLLAMA_TEST_MODE=1` is set in the
 * host process env AND the agent group's folder is `career-pilot`, the
 * config is overlaid with Ollama routing (env vars, blockedHosts, model).
 * This lets Layer 4 E2E tests exercise the full pipeline against a local
 * Ollama daemon at zero LLM cost. Production runs (no env flag) are
 * untouched. See `.specs/STRATEGY.md` testing section + the
 * `add-ollama-provider` skill for the underlying recipe.
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  // §24.140 sandbox cost lever: the PUBLIC "Watch it work" sandbox (the only
  // visitor-facing money path) runs a cheaper tier than the owner agent — Sonnet
  // by default (the `sandbox_model_tier` knob; default→Opus / sonnet / haiku).
  // Applied in PROD too (unlike dev_model_tier's dev-only branch below) and scoped
  // to the sandbox folder, so the owner's real search keeps Opus. Runs BEFORE the
  // dev_model_tier branch so a dev experiment can still override it on dev; the
  // owner-group test modes below pin their own model and are mutually exclusive.
  if (group.folder === 'career-pilot-sandbox') {
    applyModelTier(config, getConfig<string>(getDb(), 'sandbox_model_tier', 'sonnet'));
  }

  if (process.env.OLLAMA_TEST_MODE === '1' && group.folder === 'career-pilot') {
    applyOllamaTestOverrides(config);
  } else if (process.env.CLAUDE_TEST_MODE === '1' && group.folder === 'career-pilot') {
    applyClaudeTestOverrides(config);
  } else if (process.env.ENVIRONMENT === 'dev') {
    // §24.43 dev model tier: a runtime, dev-only lever to drop the orchestrator +
    // subagents off the (expensive) default Opus without a redeploy. No-op unless
    // the `dev_model_tier` preference is `sonnet`/`haiku`. Applies to both groups;
    // prod (ENVIRONMENT!=='dev') never reaches this branch. The test modes above
    // take precedence (they pin a specific model for their own purposes).
    applyModelTier(config, getConfig<string>(getDb(), 'dev_model_tier', 'default'));
  }

  // Forward fixture-mode selectors to the container so funnel-curator's
  // container-side MCP tools (queryGmailDelta / queryCalendarDelta) can
  // branch to fixture mode without a separate config-passing channel.
  // Real-API mode is what runs when these are unset.
  if (group.folder === 'career-pilot' && process.env.GMAIL_FIXTURE) {
    config.env = { ...(config.env ?? {}), GMAIL_FIXTURE: process.env.GMAIL_FIXTURE };
  }
  if (group.folder === 'career-pilot' && process.env.CALENDAR_FIXTURE) {
    config.env = { ...(config.env ?? {}), CALENDAR_FIXTURE: process.env.CALENDAR_FIXTURE };
  }

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}

/**
 * Apply the Ollama-routing overlay to a ContainerConfig in place.
 *
 * - `ANTHROPIC_BASE_URL` redirects the Anthropic SDK to the local Ollama
 *   daemon (Ollama speaks the Anthropic v1/messages API natively).
 * - `ANTHROPIC_API_KEY=ollama` is a placeholder satisfying the SDK's
 *   key requirement; Ollama ignores it.
 * - `NO_PROXY` / `no_proxy` bypass the OneCLI HTTPS proxy for
 *   `host.docker.internal` so requests reach Ollama directly instead of
 *   going through the credential gateway (OneCLI would otherwise
 *   intercept and try to inject the wrong creds).
 * - `ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET}_MODEL` redirect Claude Code's
 *   internal model aliases to the same local Ollama model. Without these,
 *   `WebSearch`/`WebFetch` (which use Haiku internally to summarize
 *   fetched content) fail with "model claude-haiku-4-5-20251001 not
 *   accessible" because Ollama doesn't host that name. Subagents declared
 *   with `model: opus` (e.g. `tailor-resume`, `prep-interview` per
 *   STRATEGY.md §5) would hit the same wall via the Opus alias.
 *   Discovered 2026-05-26 while running --flow=research-company-discovery.
 * - `blockedHosts: ['api.anthropic.com']` resolves the real Anthropic
 *   endpoint to 0.0.0.0 inside the container — defense-in-depth, so a
 *   stray config override can't accidentally bill real credits during
 *   tests.
 *
 * The model name (`glm-4.7-flash` by default; override via
 * `OLLAMA_TEST_MODEL` env) gets passed via `config.model` →
 * ProviderOptions → SDK options AND mirrored into the three alias
 * overrides above. Ollama's `/v1/messages` endpoint routes by model
 * name to the locally-loaded weight.
 *
 * Model choice: `glm-4.7-flash` is the only open model + Ollama combo
 * confirmed to round-trip Anthropic `tool_use` blocks correctly as of
 * 2026-05. qwen3-coder hits a renderer/parser mismatch in Ollama (issues
 * #12380, #15529) -- its tool calls come out as `<function=...>` XML
 * that the Anthropic shim doesn't wrap. GLM-4.7-Flash with the
 * `RENDERER glm-4.7 + PARSER glm-4.7` Modelfile directives works. See
 * `config/glm-4.7-flash.modelfile` for the registration recipe.
 */
function applyOllamaTestOverrides(config: ContainerConfig): void {
  const model = process.env.OLLAMA_TEST_MODEL || 'glm-4.7-flash';
  config.env = {
    ...(config.env ?? {}),
    ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
    ANTHROPIC_API_KEY: 'ollama',
    NO_PROXY: 'host.docker.internal',
    no_proxy: 'host.docker.internal',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  };
  config.blockedHosts = [...(config.blockedHosts ?? []), 'api.anthropic.com', 'api.portkey.ai'];
  config.model = model;
}

/**
 * Apply the Claude-routing overlay to a ContainerConfig in place.
 *
 * Used for "validate prompt quality against the production model tier"
 * runs — what does the system look like when running against real
 * Claude (Sonnet 4.6) instead of local Ollama? Triggered by setting
 * `CLAUDE_TEST_MODE=1` in the host process env.
 *
 * Unlike the Ollama override, this does NOT touch `ANTHROPIC_BASE_URL`
 * or `ANTHROPIC_API_KEY` — calls go through OneCLI's gateway, which
 * injects the real Anthropic credential at request time. We just retarget
 * Claude Code's model aliases:
 * - `ANTHROPIC_DEFAULT_SONNET_MODEL` → `claude-sonnet-4-6`
 * - `ANTHROPIC_DEFAULT_OPUS_MODEL` → `claude-sonnet-4-6` (default; route
 *   Opus aliases to Sonnet for cost — every subagent declares
 *   `model: opus` in frontmatter, but for these task shapes Sonnet is
 *   plenty capable. Override via `CLAUDE_TEST_OPUS_MODEL=claude-opus-4-7`
 *   if you need real Opus.)
 * - `ANTHROPIC_DEFAULT_HAIKU_MODEL` → `claude-haiku-4-5` (WebFetch/
 *   WebSearch use Haiku internally for content summarization)
 *
 * No `blockedHosts` entry — we WANT calls to reach Anthropic.
 *
 * Prerequisite: OneCLI gateway must be running with the Anthropic
 * secret registered (via `/init-onecli`). If the gateway has no
 * Anthropic creds, calls will fail with a credential error. The Ollama
 * override doesn't have this prerequisite because Ollama doesn't auth.
 */
function applyClaudeTestOverrides(config: ContainerConfig): void {
  const sonnetModel = process.env.CLAUDE_TEST_SONNET_MODEL || 'claude-sonnet-4-6';
  const opusModel = process.env.CLAUDE_TEST_OPUS_MODEL || sonnetModel;
  const haikuModel = process.env.CLAUDE_TEST_HAIKU_MODEL || 'claude-haiku-4-5';
  config.env = {
    ...(config.env ?? {}),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
  };
  config.model = sonnetModel;
}

/**
 * Apply a model-tier overlay in place — the pure tier→config mapping behind two
 * callers: the dev-only `dev_model_tier` lever (§24.43, both groups, set from
 * `/dev`) and the prod-safe `sandbox_model_tier` lever (§24.140, the public
 * sandbox group only). It retargets the orchestrator's own model AND every
 * subagent's `model: opus` alias to a cheaper tier — no redeploy; picked up on the
 * next container spawn. Mirrors `applyClaudeTestOverrides` (env alias redirects +
 * `config.model`); the alias redirects also catch Haiku-internal calls
 * (WebFetch/WebSearch summarization). Works whether the agent hits
 * `api.anthropic.com` directly or routes through Portkey (§24.44) — Claude Code
 * resolves the alias client-side before the request.
 *
 * - `default` (or any unknown value) → no-op: the real models (Opus orchestrator
 *   + subagents).
 * - `sonnet` → Opus aliases + the orchestrator model → Sonnet; Haiku kept.
 * - `haiku` → everything (orchestrator + all aliases) → Haiku: cheapest, for
 *   plumbing / loop runs where output quality doesn't matter.
 */
export function applyModelTier(config: ContainerConfig, tier: string): void {
  const SONNET = 'claude-sonnet-4-6';
  const HAIKU = 'claude-haiku-4-5';
  if (tier === 'sonnet') {
    config.env = {
      ...(config.env ?? {}),
      ANTHROPIC_DEFAULT_OPUS_MODEL: SONNET,
      ANTHROPIC_DEFAULT_SONNET_MODEL: SONNET,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU,
    };
    config.model = SONNET;
  } else if (tier === 'haiku') {
    config.env = {
      ...(config.env ?? {}),
      ANTHROPIC_DEFAULT_OPUS_MODEL: HAIKU,
      ANTHROPIC_DEFAULT_SONNET_MODEL: HAIKU,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU,
    };
    config.model = HAIKU;
  }
  // 'default'/unknown → no-op (real models).
}
