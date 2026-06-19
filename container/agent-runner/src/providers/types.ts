export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
  /**
   * Per-group tool removals appended to the provider's static
   * disallow list. Used by the career-pilot-sandbox group to remove
   * `mcp__nanoclaw__create_gmail_draft` from the agent's SDK context.
   * See host-side migration 109 + STRATEGY.md §24.3 task #86.
   */
  extraDisallowedTools?: string[];

  /**
   * Emit `trace` ProviderEvents (tool calls, subagent dispatch, per-run cost)
   * for the public Recruiter Simulator's live activity pane. Host-gated to the
   * career-pilot-sandbox group only (materializeContainerJson sets
   * container.json `emitTrace`); false (the default) for the owner group keeps
   * the event stream byte-identical to upstream. See STRATEGY.md §24.20.
   */
  emitTrace?: boolean;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * §24.128: force this stdio server connected before the turn-1 prompt is
   * built (and its tools always present, never deferred behind tool search).
   * At claude-agent-sdk 0.3.x, MCP startup is non-blocking by default — without
   * this, a cold container's first turn can race the connect and find our
   * career-pilot tools absent.
   */
  alwaysLoad?: boolean;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

/**
 * A single rich-trace step for the simulator's live activity pane (§24.20).
 * `tool` — a non-Task tool call; `subagent` — a `Task` dispatch (subagent in
 * `subagent`); `result` — end-of-run cost. `parent_tool_use_id` is non-null
 * when the call originated inside a subagent's context (nested indentation).
 */
export interface TraceEvent {
  t: 'tool' | 'subagent' | 'result';
  name?: string;
  subagent?: string;
  parent_tool_use_id?: string | null;
  input_summary?: string;
  cost_usd?: number;
}

/**
 * Per-turn LLM economics captured from the SDK `result` message (§24.34).
 * The honest unit is one `query()` call — the SDK resolves cost only per-turn
 * (`total_cost_usd`), with no per-subagent/per-tool breakdown (subagent usage
 * rolls up into the parent result). `record_calls` counts this turn's
 * `record_funnel_event` / `record_progress` dispatches: the poll-loop emits a
 * turn-telemetry row only when `> 0` (the "portal-worthy" gate). All numeric
 * fields are JSON-serializable for the fire-and-forget host action payload.
 */
export interface TurnTelemetry {
  /** Primary (highest-cost) model name across the turn, or null if unknown. */
  model_used: string | null;
  /** Billable token volume = sum of input + output across models. */
  tokens: number;
  /** round(total_cost_usd * 100) — an SDK-side estimate, not authoritative. */
  cost_cents: number;
  /** 1 if any model read from cache this turn, else 0. */
  cache_hit: 0 | 1;
  /** Turn wall-clock duration (SDK `duration_ms`). */
  latency_ms: number;
  /** record_* tool_use dispatches this turn (the portal-worthy gate). */
  record_calls: number;
  /**
   * §24.78: the `subagent_type`s the orchestrator dispatched this turn (`Agent`/
   * `Task` blocks), deduped. PII-safe — the subagent NAME only, never its prompt.
   * The host emits a deterministic `subagent_progress` lifecycle row per name so
   * the owner-path public stream never goes silent when a subagent ran (the model
   * skipping `record_progress` no longer blanks the trace). Empty for most turns.
   */
  subagent_dispatches?: string[];
  /** Extra context persisted into the audit row's details_json. */
  details: {
    num_turns: number;
    duration_api_ms: number;
    total_cost_usd: number;
    model_usage: Record<
      string,
      { input: number; output: number; cache_read: number; cache_creation: number; cost_usd: number }
    >;
  };
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * Turn complete. `telemetry` (§24.34) is present when the SDK emitted a
   * `result` message with usage; the poll-loop forwards it as a per-turn
   * audit row when the turn was portal-worthy. Optional + additive — the
   * owner event stream is otherwise byte-identical to upstream.
   */
  | { type: 'result'; text: string | null; telemetry?: TurnTelemetry }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * Rich-trace step for the simulator activity pane. Emitted only when the
   * provider was constructed with `emitTrace` (sandbox group); the poll-loop
   * writes each as a `kind:'trace'` outbound row. See STRATEGY.md §24.20.
   */
  | { type: 'trace'; trace: TraceEvent };
