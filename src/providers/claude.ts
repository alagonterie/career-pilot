/**
 * Claude provider container config — registered when the host points the agent
 * runtime at a custom Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL`.
 *
 * In this project that endpoint is **Portkey** (STRATEGY §24.44): all LLM paths
 * route through the gateway, the agent runtime included. The real Anthropic key
 * never enters the container — it lives in Portkey's AI Provider; the Portkey
 * key lives in OneCLI, which injects `x-portkey-api-key` on the wire for
 * `api.portkey.ai`. The container only carries:
 *   - ANTHROPIC_BASE_URL          — where the SDK calls (the Portkey gateway)
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an Authorization header
 *     for OneCLI to overwrite; not a real credential
 *   - ANTHROPIC_CUSTOM_HEADERS    — `x-portkey-provider` (the AI Provider slug
 *     that holds the Anthropic key) + `x-portkey-config` (the Config that
 *     forwards `anthropic-beta`, so Claude Code's prompt caching survives the
 *     gateway hop — a load-bearing cost factor) + the observability headers
 *     `x-portkey-trace-id` (the session id, grouping the turn's orchestrator +
 *     subagent fan-out into one Portkey trace) and `x-portkey-metadata`
 *     (environment / agent_group / session_id, so the dashboard is segmentable)
 *
 * Without `ANTHROPIC_BASE_URL` set this contributes nothing (a standard install
 * hitting api.anthropic.com directly). See STRATEGY.md §24.46 for the
 * observability headers.
 */
import { readEnvFile } from '../env.js';
import { buildPortkeyMetadata } from '../portkey.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Per-spawn observability context for the Portkey routing headers (§24.46). */
export interface ClaudePortkeyObservability {
  /** Session id → the Portkey trace id (groups the session's LLM fan-out). */
  sessionId?: string;
  /** Agent group folder → the `agent_group` metadata tag (owner vs sandbox). */
  agentGroup?: string;
  /** Deploy environment → the `environment` metadata tag. */
  environment?: string;
}

/**
 * Build the container env for the Claude provider from the host `.env` values.
 * Pure (no I/O) so it's unit-testable. Returns `{}` when no custom endpoint is
 * configured. The Portkey headers are only added when a base URL is present;
 * `x-portkey-api-key` is intentionally NOT here (OneCLI injects it on the wire).
 */
export function buildClaudeContainerEnv(
  dotenv: Record<string, string | undefined>,
  obs?: ClaudePortkeyObservability,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!dotenv.ANTHROPIC_BASE_URL) return env;

  env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = 'placeholder';

  // 1-hour prompt cache (§24.49). The container provider defaults this ON; we
  // forward the box .env value (bootstrap writes `=1`) only when present so it
  // stays an override hook — set `=0` to disable the 1h cache without rebuilding
  // the image. Absent → the container's default `1` applies.
  if (dotenv.ENABLE_PROMPT_CACHING_1H) {
    env.ENABLE_PROMPT_CACHING_1H = dotenv.ENABLE_PROMPT_CACHING_1H;
  }

  // Portkey routing headers (§24.44). Newline-separated `Name: value` pairs, per
  // Portkey's Claude Code integration. The slug names the AI Provider (Anthropic
  // key holder) — reuses `PORTKEY_AI_PROVIDER`, the same slug the host-side sim
  // prose uses; the config forwards `anthropic-beta`. Both are non-secret.
  const headers: string[] = [];
  if (dotenv.PORTKEY_AI_PROVIDER) {
    headers.push(`x-portkey-provider: @${dotenv.PORTKEY_AI_PROVIDER.replace(/^@/, '')}`);
  }
  if (dotenv.PORTKEY_CONFIG_ID) {
    headers.push(`x-portkey-config: ${dotenv.PORTKEY_CONFIG_ID}`);
  }

  // Observability headers (§24.46). The session id is the Portkey trace id, so a
  // turn's orchestrator + subagent fan-out groups into one trace (the per-request
  // granularity the per-turn SDK rollup can't give); metadata tags env + group so
  // owner-vs-sandbox spend is separable. Non-secret, no PII.
  if (obs?.sessionId) headers.push(`x-portkey-trace-id: ${obs.sessionId}`);
  const metadata = buildPortkeyMetadata({
    environment: obs?.environment,
    agent_group: obs?.agentGroup,
    session_id: obs?.sessionId,
  });
  if (Object.keys(metadata).length > 0) {
    headers.push(`x-portkey-metadata: ${JSON.stringify(metadata)}`);
  }

  if (headers.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = headers.join('\n');

  return env;
}

registerProviderContainerConfig('claude', (ctx) => {
  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'PORTKEY_AI_PROVIDER',
    'PORTKEY_CONFIG_ID',
    'ENABLE_PROMPT_CACHING_1H',
  ]);
  return {
    env: buildClaudeContainerEnv(dotenv, {
      sessionId: ctx.sessionId,
      agentGroup: ctx.agentGroupFolder,
      environment: ctx.hostEnv.ENVIRONMENT,
    }),
  };
});
