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
 *     gateway hop — a load-bearing cost factor)
 *
 * Without `ANTHROPIC_BASE_URL` set this contributes nothing (a standard install
 * hitting api.anthropic.com directly).
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Build the container env for the Claude provider from the host `.env` values.
 * Pure (no I/O) so it's unit-testable. Returns `{}` when no custom endpoint is
 * configured. The Portkey headers are only added when a base URL is present;
 * `x-portkey-api-key` is intentionally NOT here (OneCLI injects it on the wire).
 */
export function buildClaudeContainerEnv(dotenv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  if (!dotenv.ANTHROPIC_BASE_URL) return env;

  env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = 'placeholder';

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
  if (headers.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = headers.join('\n');

  return env;
}

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'PORTKEY_AI_PROVIDER', 'PORTKEY_CONFIG_ID']);
  return { env: buildClaudeContainerEnv(dotenv) };
});
