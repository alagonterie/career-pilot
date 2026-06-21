/**
 * Owner agent tool-palette trim (§24.49d + §24.49e).
 *
 * Under `bypassPermissions` the SDK ignores `allowedTools` and exposes EVERY
 * built-in plus every MCP tool; the real palette is `(all) − disallowedTools`.
 * These entries are removed from the owner agent's SDK context (bare built-in
 * names + `mcp__<server>__<name>` MCP names both work under bypass — see
 * AGENT_SDK_PATTERNS §6) to shrink the ~55K-token per-turn preamble, which
 * compounds with the 1h cache (§24.49b): every cache-write AND warm read is
 * smaller.
 *
 * Inclusion rule: a tool belongs here ONLY if it is never INVOKED in a
 * documented owner flow — by neither the orchestrator (persona's built-ins:
 * Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch/Agent/TodoWrite + the
 * career-pilot MCP tools) nor any of the six subagents (palettes: WebSearch/
 * WebFetch + record_progress + fetch_source/record_job_lead + the pipeline-scribe
 * read set). The guard test asserts that invariant so a future edit can't
 * disallow a load-bearing tool. Verified present-but-unused against a live owner
 * request's `tools[]` array.
 *
 * `Skill` (§24.49e) is the one entry that IS in the SDK's default palette yet
 * never invoked: the owner runs no skills (the persona merely listed it). Per
 * the Claude Code docs ("Disable all skills by denying the Skill tool"), denying
 * it removes the ENTIRE ~18-skill descriptions block (NanoClaw-bundled + CC
 * built-ins) that loads into every turn's preamble. Reversible in one line if we
 * later add custom career-pilot skills — we'd then re-enable Skill and scope the
 * visible set via `container_configs.skills` (an allow-list) instead of `"all"`.
 */
export const OWNER_DISALLOWED_TOOLS: string[] = [
  // Built-in SDK tools the job-search agent never reaches for. TeamCreate's
  // schema alone is ~4KB (the whole team-workflow doc); SendMessage + Monitor
  // are ~2KB each — the three fattest entries in the array.
  'TeamCreate',
  'TeamDelete',
  'SendMessage', // agent-to-agent teammate messaging; we deliver via mcp__nanoclaw__send_message
  'Monitor',
  'TaskOutput', // background-task mgmt; the Agent subagent flow is synchronous
  'TaskStop',
  'NotebookEdit', // Jupyter — irrelevant
  'PushNotification', // desktop/phone push; we reach the candidate via Telegram
  'RemoteTrigger', // claude.ai remote-trigger API
  // Self-modification / dynamic-group MCP tools. The owner uses the predefined
  // subagents via Agent and never rebuilds its own container.
  'mcp__nanoclaw__install_packages',
  'mcp__nanoclaw__add_mcp_server',
  'mcp__nanoclaw__create_agent',
  // §24.144/§24.146: the sandbox-only structured deliverable emissions (tailored
  // résumé + cold-outreach email). Present in the shared MCP server but never
  // invoked by the owner (the owner group runs no simulator), so present-but-
  // unused — disallow to keep them out of the owner preamble.
  'mcp__nanoclaw__emit_tailored_resume',
  'mcp__nanoclaw__emit_cold_email',
  // The Skill tool (§24.49e). Denying it disables ALL skills (per the CC docs),
  // dropping the ~18-skill descriptions block the owner never invokes. See header.
  'Skill',
];
