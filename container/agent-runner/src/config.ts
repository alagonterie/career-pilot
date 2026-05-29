/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  model?: string;
  effort?: string;
  /**
   * Extra tools to remove from the agent's SDK context (concatenated with
   * the static SDK_DISALLOWED_TOOLS in providers/claude.ts). Per-group
   * isolation — e.g., the career-pilot-sandbox group lists
   * `mcp__nanoclaw__create_gmail_draft` so sandbox visitors can't see it.
   * See host-side `migration 109` + STRATEGY.md §24.3 task #86.
   */
  disallowedTools?: string[];
  /**
   * Emit simulator trace events (tool/subagent/cost) for the live activity
   * pane. Host sets this true only for the career-pilot-sandbox group
   * (materializeContainerJson). See STRATEGY.md §24.20.
   */
  emitTrace?: boolean;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    disallowedTools: Array.isArray(raw.disallowedTools)
      ? (raw.disallowedTools as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    emitTrace: raw.emitTrace === true,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
