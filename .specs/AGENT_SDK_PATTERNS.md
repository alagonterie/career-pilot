# Claude Agent SDK — Canonical Patterns for Career Pilot

This is a cribsheet, not a tutorial. It captures the patterns we use, the gotchas we've already discovered, and the version-pinning discipline. Originally sourced from the official [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview) at SDK version 0.3.150.

> **Version caveat (2026-05-26):** NanoClaw's vendored `container/agent-runner/package.json` pins `@anthropic-ai/claude-agent-sdk: ^0.2.128` — a major version behind what most of this doc was written against. Patterns that hinge on 0.3-only APIs (`startup()`, `forkSession`, `maxBudgetUsd`, etc.) need verification against the 0.2.x surface before relying on them. See [NANOCLAW_INTERNALS.md](NANOCLAW_INTERNALS.md) §11 Δ2 for the rationale; bump scheduled for Phase 5+ when there's a concrete reason.

For STRATEGY.md context: this doc is referenced by §5 (subagents), §6 (in-process tools), §11 (system modes via hooks), §16 (local dev), §17 (observability).

---

## 0. Disambiguation — we use the Agent SDK, NOT Managed Agents

Two different Anthropic products with similar names. Easy to confuse.

| | Agent SDK (us) | Managed Agents (not us) |
|---|---|---|
| What | A library | A hosted REST API |
| Install | `npm install @anthropic-ai/claude-agent-sdk` | `client.beta.agents.create(...)` |
| Runs in | Your process (our Bun container) | Anthropic-managed infrastructure |
| Session state | JSONL on your filesystem | Anthropic-hosted event log |
| Custom tools | In-process TS functions | RPC pattern, you fulfill from outside |
| Best for | Local prototyping, agents that touch our filesystem and services | Production with no infra to operate |

Docs we cite: `code.claude.com/docs/en/agent-sdk/*`. We do **not** read or follow `platform.claude.com/docs/en/managed-agents/*` — wrong product.

---

## 1. Pin the version

```json
// container/agent-runner/package.json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.128"
  }
}
```

This is the upstream NanoClaw pin (`^0.2.128`). The caret on a 0.x version is implicitly tight — npm resolves it to `0.2.x` only, never auto-floating to 0.3.x. So we ARE pinned at the major level; the caret only allows patch + minor updates within 0.2.

The SDK is on a Claude Code CLI version parity track and has had breaking changes in the last 6 months (v0.3.142 removed the V2 Session API; `TodoWrite` renamed to `TaskCreate/Update/Get/List`; `options.env` changed semantics). The 0.3.x branch differs meaningfully from 0.2.x in those areas — when reading external docs, verify which version they're written against.

Upgrade discipline: do not bump independent of NanoClaw upstream. If we bump, do it via a coordinated upstream sync (the `/update-nanoclaw` skill flow). Check the [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) before any bump. Test in dev. Bump rarely.

---

## 2. Canonical `query()` invocation for career-pilot

The agent-runner inside our container calls `query()` like this:

```typescript
import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import { resumeSessionForUser, saveSessionId } from "./sessions";
import { careerPilotMcpServer } from "./mcp-tools";
import { hooks } from "./hooks";

// One-time pre-warm at container boot
await startup();   // first query() call ~20x faster after this

async function processUserMessage(userId: string, prompt: string, sandbox: boolean) {
  const priorSessionId = await resumeSessionForUser(userId);
  const opts = {
    model: sandbox ? "claude-opus-4-7" : "claude-opus-4-7",   // (same; we may differentiate later)
    resume: priorSessionId,            // undefined for new sessions
    mcpServers: { "career-pilot": careerPilotMcpServer },
    hooks: hooks,                       // PreToolUse + PostToolUse, see §5

    // Tool surface:
    allowedTools: sandbox
      ? ["Read", "WebSearch", "WebFetch", "Agent", "mcp__career-pilot__analyze_jd", "mcp__career-pilot__sanitize_text"]
      : undefined,                      // owner: all tools available
    disallowedTools: sandbox
      ? ["Write", "Edit", "Bash", "mcp__career-pilot__update_application",
         "mcp__career-pilot__send_outreach_email", "mcp__career-pilot__query_gmail",
         "mcp__career-pilot__query_calendar", "mcp__career-pilot__save_outreach_draft",
         "mcp__career-pilot__record_funnel_event"]
      : undefined,

    // permissionMode: NanoClaw's vendored provider hard-codes "bypassPermissions";
    // see §6 for the security model that flows from that choice.
    maxTurns: sandbox ? 30 : undefined,
    maxBudgetUsd: sandbox ? 0.10 : undefined,           // sandbox per-run cap
    includePartialMessages: true,                       // for SSE token streaming
    settingSources: ["project"],                        // load .claude/CLAUDE.md + .claude/agents/
    abortController: createAbortController(userId),
    env: {
      ...process.env,
      ENABLE_PROMPT_CACHING_1H: "1",                    // 1-hour TTL on caches
    },
  };

  let capturedSessionId: string | undefined;
  for await (const msg of query({ prompt, options: opts })) {
    if (msg.type === "system" && msg.subtype === "init") {
      capturedSessionId = msg.session_id;
    }
    // ... handle message kinds (assistant, tool_use, result, stream_event) ...
  }

  if (capturedSessionId) {
    await saveSessionId(userId, capturedSessionId);
  }
}
```

Key fields explained:
- `resume`: pass `undefined` to start fresh; pass a stored UUID to continue
- `forkSession: true` (combined with `resume`) → branches the conversation into a new session
- `includePartialMessages: true` → emit `StreamEvent` messages with token deltas (used for `/simulator` and `/live` SSE)
- `settingSources: ["project"]` → loads `.claude/CLAUDE.md` and `.claude/agents/*.md` from the agent group folder
- `env` REPLACES `process.env` (not overlays) — must spread manually. Footgun caught in v0.3.142.

---

## 3. Session persistence across container restarts

NanoClaw spawns one container per session, with a 30-min idle timeout. Containers die. Sessions must survive.

**The problem:** Agent SDK stores sessions at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` in the container's local filesystem. Container restarts → JSONL is gone → `resume: sessionId` fails → fresh session, no context.

**The fix:** Mirror the session JSONL to shared persistent storage. NanoClaw's per-session mount at `/workspace/.claude/` is *already* on the host-mounted session folder, so as long as we keep `cwd` = `/workspace/agent` (the agent group folder), Claude Agent SDK writes JSONLs to a path that survives container teardown.

```typescript
// In container's agent-runner, set cwd explicitly
process.chdir("/workspace/agent");                   // agent group folder, mounted RW
// Now Claude Agent SDK writes JSONLs to /workspace/.claude/projects/...
// Which is on the session folder mount → survives container teardown
```

**Session table on the host (central DB):**

```sql
-- See STRATEGY.md §3, migration 108
CREATE TABLE user_sessions (
  user_id           TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,   -- the Agent SDK session UUID
  created_at        TEXT NOT NULL,
  last_resumed_at   TEXT NOT NULL
);
```

On the next user message, we look up `session_id` for the user, pass it to `query({ options: { resume: session_id } })`. If the JSONL still exists, resume; otherwise the SDK starts fresh (it won't error — just begins a new session with the supplied ID).

**Cleanup:** Sessions don't auto-cleanup. Add a weekly cron that deletes JSONLs older than 90 days (configurable via preferences). The session row in the DB can stay longer for analytics — just clear `session_id` if the JSONL is gone.

---

## 4. The 5 subagents — filesystem agent definitions

We use **filesystem-based agents** (markdown files in `.claude/agents/<name>.md`) rather than the programmatic `agents: { ... }` option. Reasons: they live in the agent group folder alongside skills, they're version-controlled, and they don't require restarting the host to update.

Skeleton for each (see STRATEGY.md §5 for the actual content per agent):

```markdown
---
description: <one-sentence trigger description; Claude reads this to decide when to invoke>
tools: [WebSearch, WebFetch]    # subset; empty means "inherit all from parent"
model: opus                     # alias; "opus" | "sonnet" | "haiku" | full model ID
maxTurns: 12                    # hard cap; prevents runaway
---

<system prompt body — the agent's persona, rules, output format>
```

**Where they live:**

```
groups/career-pilot/.claude/agents/
├── research-company.md
├── tailor-resume.md
├── draft-outreach.md
├── prep-interview.md
└── scrape-jobs.md

groups/career-pilot-sandbox/.claude/agents/
├── research-company.md     (same content as owner — read-only tools anyway)
├── tailor-resume.md
└── draft-outreach.md
```

**Auto-loaded when** `settingSources: ["project"]` is set in `query()` options.

**Subagent permission inheritance gotcha:** When the parent's `permissionMode` is `bypassPermissions` / `acceptEdits` / `auto`, subagents **inherit it** and cannot override. Both our agent groups run with the parent's `bypassPermissions` (NanoClaw upstream default), so subagents inherit that too. The actual constraint on what a subagent can do comes from its definition's `tools:` list (a soft constraint — the subagent prompt declares the palette) + our parent-level `disallowedTools` (which removes tools from the entire SDK context, subagents included). Don't expect a subagent to be more locked-down than its parent at the SDK level.

**Subagent cost tracking:** Messages from inside a subagent's context include a `parent_tool_use_id` field. Use this to attribute cost per subagent invocation.

---

## 5. Hooks — sanitization mirror + permission gating

Two hooks earn their keep in career-pilot:

### `PostToolUse` for `public_audit_trail` sanitization mirror

Every time a tool runs that produces information worth surfacing on the portal — `update_application`, `record_funnel_event`, etc. — a `PostToolUse` hook intercepts the result, sanitizes it, and writes a sanitized row to `public_audit_trail`.

```typescript
import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { sanitize } from "../portal/sanitizer";
import { writePublicAudit } from "../portal/public-audit";

const auditMirror: HookCallback = async (input, toolUseId, { signal }) => {
  const postInput = input as PostToolUseHookInput;
  const toolName = postInput.tool_name;
  if (!["mcp__career-pilot__update_application",
        "mcp__career-pilot__record_funnel_event",
        "mcp__career-pilot__save_outreach_draft"].includes(toolName)) {
    return {};   // not relevant
  }
  try {
    const sanitized = await sanitize(JSON.stringify(postInput.tool_result));
    if (sanitized !== null) {
      await writePublicAudit({
        category: "agent_trace",
        agent_name: postInput.agent_name,   // who invoked it
        proactive: postInput.parent_tool_use_id ? 0 : 1,
        summary: sanitized,
        // ... cost, latency from postInput.metadata
      });
    }
    // If sanitized === null, the event was dropped (Pass 3 LLM flagged a leak risk)
  } catch (err) {
    // CRITICAL: never throw from a hook. Log and return.
    console.error("[audit-mirror] failed:", err);
  }
  return {};   // empty output = let the tool result through unchanged
};

const hooks = {
  PostToolUse: [{
    matcher: "^mcp__career-pilot__(update_application|record_funnel_event|save_outreach_draft)$",
    hooks: [auditMirror],
  }],
};
```

### `PreToolUse` for runtime permission gating

For the external-action tools (`send_outreach_email`), gate at hook time:

```typescript
const liveModeGate: HookCallback = async (input, toolUseId, { signal }) => {
  const preInput = input as PreToolUseHookInput;
  if (preInput.tool_name === "mcp__career-pilot__send_outreach_email") {
    const mode = await getLiveMode();
    if (!mode.live) {
      return {
        systemMessage: "DRY_RUN: external send blocked. Draft saved.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "LIVE_MODE is false",
        },
      };
    }
    // Live mode: still require approval card
    const approval = await requestApprovalCard({ /* ... */ });
    if (!approval.granted) {
      return {
        systemMessage: "Owner declined approval.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Owner declined approval card",
        },
      };
    }
  }
  return {};
};

hooks.PreToolUse = [{ matcher: "^mcp__career-pilot__send_outreach_email$", hooks: [liveModeGate] }];
```

**Hook semantics:**
- Multiple hooks on the same event run in **parallel**; most restrictive decision wins (`deny > defer > ask > allow`).
- Hooks must NOT throw — catch internally; return early on errors.
- `matcher` is a regex against tool name.
- `async: true` is fire-and-forget (cannot block).

### `SessionStart` for pre-warming + persona injection

```typescript
const sessionInit: HookCallback = async (input, _, { signal }) => {
  // Generate fresh persona.local.md from candidate_profile table
  await regeneratePersona();
  // Pre-warm research cache if there's a pending application
  return {};
};
hooks.SessionStart = [{ hooks: [sessionInit] }];
```

---

## 6. Permission modes — the NanoClaw upstream model

NanoClaw's vendored Claude provider (`container/agent-runner/src/providers/claude.ts`) hard-codes:

```ts
permissionMode: 'bypassPermissions',
allowDangerouslySkipPermissions: true,
```

We **accept this** rather than fork the provider. Decision documented in [NANOCLAW_INTERNALS.md](NANOCLAW_INTERNALS.md) §11 Δ1. The security perimeter is moved out of in-SDK permission gating and into the surrounding layers:

| Layer | What it enforces |
|---|---|
| Container mount geometry | Agent has RW only to its session folder + group dir + `/home/node/.claude`; central `data/v2.db` is NOT mounted. The agent literally cannot reach private host state from filesystem alone. |
| `disallowedTools` (bare names) | Removes tools from the agent's context entirely — the agent doesn't know they exist. Works regardless of `permissionMode`. Our primary palette-shaping mechanism. |
| `PreToolUse` hook | Defense-in-depth: blocks any disallowed tool that slipped through (e.g. an unknown future SDK builtin). Also records `tool_declared_timeout_ms` for the host sweep. |
| Approvals module (host-side) | For irreversible owner-facing actions (`send_outreach_email`, schema-altering self-mod, etc.), the MCP tool enqueues an approval card via the approvals primitive and blocks until the owner answers. Same pattern as NanoClaw's `self-mod` tools. |
| Hard caps | `maxTurns`, `maxBudgetUsd`, OneCLI scope partitioning between owner and sandbox. |

### Per-group differentiation

Both `career-pilot` and `career-pilot-sandbox` go through the same upstream provider, so both run with `bypassPermissions`. Group-level differentiation comes from:

| Knob | Owner | Sandbox |
|---|---|---|
| `disallowedTools` | None (full palette) | `["Write", "Edit", "Bash", "mcp__career-pilot__update_application", "mcp__career-pilot__record_funnel_event", "mcp__career-pilot__save_outreach_draft", "mcp__career-pilot__send_outreach_email", "mcp__career-pilot__query_gmail", "mcp__career-pilot__query_calendar"]` |
| `maxTurns` | unlimited | 30 |
| `maxBudgetUsd` | tracked via Portkey | 0.10 per run (hard cap) |
| OneCLI scope | Full vault (Gmail, Calendar, Cloudflare, Telegram) | Sandbox sub-vault (sandbox-only Portkey key with separate budget) |
| Subagents | All five | `research-company`, `tailor-resume`, `draft-outreach` only |
| Session model | `agent-shared` (one brain across channels) | `per-thread` (each visitor isolated) |

**The bare-name `disallowedTools` removal is the load-bearing mechanism for the sandbox.** It cannot be bypassed by `bypassPermissions` because the tools are simply not in the agent's tool listing at all.

### What `bypassPermissions` actually changes

Tool calls skip the SDK's prompt-for-permission step and go straight to the handler. The handler still runs, the hook still fires, the disallow list still applies. The thing we lose is the per-call interactive "Allow this Bash command?" gate — which we wouldn't have a UX surface for anyway in this headless model.

### Anti-pattern

Don't try to constrain `bypassPermissions` with `allowedTools` thinking it'll deny unlisted tools — `allowedTools` is bypassed too. Use `disallowedTools` with bare names.

---

## 7. Custom tools — `createSdkMcpServer` wrapping

All 14 in-process tools live in `groups/career-pilot/agent-runner-src/mcp-tools/` and are bundled into one `createSdkMcpServer`:

```typescript
// groups/career-pilot/agent-runner-src/mcp-tools/index.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const updateApplication = tool(
  "update_application",
  "Update an existing application's status, role title, salary range, or notes. Use after status-change events (recruiter signal, interview scheduling, etc.).",
  {
    id: z.string().describe("Application UUID"),
    patch: z.object({
      status: z.enum([
        "BOOKMARKED", "APPLIED", "SCREENING", "TECH_SCREEN",
        "SYS_DESIGN", "FINAL", "OFFER", "REJECTED", "WITHDRAWN"
      ]).optional(),
      role_title: z.string().optional(),
      jd_text: z.string().optional(),
      // ... etc
    }).describe("Partial update payload — only the fields to change"),
  },
  async (args, extras) => {
    try {
      const updated = await db.run(
        `UPDATE applications SET ...`,
        // ...
      );
      return {
        content: [{ type: "text", text: `Updated application ${args.id}.` }],
        structuredContent: { application_id: args.id, fields_updated: Object.keys(args.patch) },
      };
    } catch (err) {
      // NEVER throw — return isError for the model to handle gracefully
      return {
        content: [{ type: "text", text: `Failed to update: ${String(err)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: false, destructiveHint: false } }
);

// ... define all 14 tools ...

export const careerPilotMcpServer = createSdkMcpServer({
  name: "career-pilot",
  version: "0.1.0",
  tools: [
    updateApplication, analyzeJd, parseEmail, sanitizeText, /* ... */
  ],
});
```

**Tool naming convention:** `mcp__career-pilot__<tool_name>` (auto-derived from server name + tool name).

**Returning rich content:**

```typescript
// Image (e.g., a generated chart for /admin dashboard)
return { content: [{ type: "image", data: pngBase64, mimeType: "image/png" }] };

// Structured + text
return {
  content: [{ type: "text", text: "Funnel snapshot generated." }],
  structuredContent: { active: 4, interviewing: 2, offers: 1 },
};
```

**`structuredContent`** is the right field for typed data the model can reason about. Don't pack JSON into the `text` content if you can avoid it — the model parses structured fields more reliably.

---

## 8. Streaming SSE to the frontend

For `/simulator/:id/stream` and `/live/stream`:

```typescript
// src/modules/portal/api.ts
app.get("/api/simulator/:id/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");   // disable proxy buffering

  const ab = new AbortController();
  req.on("close", () => ab.abort());

  try {
    for await (const message of query({
      prompt: getPrompt(req.params.id),
      options: {
        includePartialMessages: true,
        abortController: ab,
        // ... sandbox config from §2
      },
    })) {
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          res.write(`event: text\ndata: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          res.write(`event: tool_start\ndata: ${JSON.stringify({ name: event.content_block.name })}\n\n`);
        }
      } else if (message.type === "assistant" && message.parent_tool_use_id) {
        // Inside a subagent's context — useful for the live trace stream
        res.write(`event: subagent\ndata: ${JSON.stringify({ subagent_id: message.parent_tool_use_id })}\n\n`);
      } else if (message.type === "result") {
        res.write(`event: done\ndata: ${JSON.stringify({ cost: message.total_cost_usd, usage: message.modelUsage })}\n\n`);
        break;
      }
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
  } finally {
    res.end();
  }
});
```

Frontend consumes via `fetch` with a stream reader (NOT `EventSource`, so we can pass auth headers and get HTTP/2 multiplexing):

```typescript
// frontend route loader or client effect
const res = await fetch(`/api/simulator/${id}/stream`, {
  headers: { "x-turnstile-token": turnstileToken },
});
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  // parse SSE frames from buffer ...
}
```

---

## 9. Cost tracking

Per-call cost from `ResultMessage`:

```typescript
if (message.type === "result") {
  // Aggregate
  const totalCost = message.total_cost_usd;   // client-side estimate
  // Per-model breakdown
  const perModel = message.modelUsage;
  // {
  //   "claude-opus-4-7": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD },
  //   "claude-haiku-4-5": { ... }
  // }
}
```

**Per-subagent cost: dedup by `message.id`.** Parallel tool calls and parallel subagents emit multiple `AssistantMessage` events with the same `message.id`. To not double-count:

```typescript
const seenIds = new Set<string>();
let cost = 0;
for await (const m of query(...)) {
  if (m.type === "assistant") {
    const id = m.message.id;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      // accumulate from m.message.usage
    }
  }
}
```

**Authoritative cost:** `total_cost_usd` is an SDK-side estimate from a bundled price table. For real billing, use [Portkey's analytics API](https://docs.portkey.ai) (we already use it for portal telemetry) or Anthropic's [Usage and Cost API](https://docs.claude.com/en/api/admin/usage). Don't bill or budget on `total_cost_usd` alone.

---

## 10. Pre-warming on container boot

```typescript
import { startup } from "@anthropic-ai/claude-agent-sdk";

// Run ONCE before the first query()
await startup();
```

Per the docs, makes the first `query()` call ~20× faster. Worth doing at container start — Bun launches, calls `startup()`, then begins polling its session DB.

---

## 11. MCP server lifecycle

The career-pilot in-process MCP server (our 14 tools) is straightforward: pass via `mcpServers: { "career-pilot": careerPilotMcpServer }`.

For potential external MCP (none in v1, but if we add `@modelcontextprotocol/server-github` later):

```typescript
mcpServers: {
  github: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    alwaysLoad: true,    // block session start until this server is connected
  }
}
```

**Default behavior:** `MCP_CONNECTION_NONBLOCKING=1` — servers connect in background; session starts immediately; servers show `status: "pending"` in `system:init`. Set `alwaysLoad: true` per-server if you want to block.

---

## 12. Anti-patterns to avoid

1. **Throwing from tool handlers.** Always `return { isError: true, content: [{ type: "text", text: "..." }] }`. Throwing kills the agent loop.
2. **Throwing from hooks.** Same rule — catch internally, log, return empty output.
3. **Forking the Claude provider to override `bypassPermissions`.** Avoid. NanoClaw upstream uses `bypassPermissions` deliberately; we accept it and enforce restrictions via `disallowedTools` + approvals module + mount geometry. See §6.
4. **Relying on `total_cost_usd` for billing.** Always reconcile against Portkey/Anthropic billing APIs.
5. **`options.env` overlay assumption.** Spread `process.env` explicitly: `env: { ...process.env, MY_VAR: "..." }`. Otherwise the entire env is replaced.
6. **Container `cwd` mismatch.** Set `process.chdir("/workspace/agent")` so session JSONLs land on the persistent mount.
7. **Skipping `parent_tool_use_id` dedup.** Cost tracking double-counts subagent work if you don't dedup by `message.id`.
8. **Forgetting `settingSources: ["project"]`.** Without it, `.claude/CLAUDE.md` and `.claude/agents/*.md` aren't loaded.
9. **`MCP_CONNECTION_NONBLOCKING` reliance.** Critical MCP servers should set `alwaysLoad: true` rather than depending on background connection completing.
10. **Long-running session JSONLs unbounded.** Add a weekly cleanup cron, configurable retention via preferences.

---

## 13. Quick reference card

```
Install:               npm install @anthropic-ai/claude-agent-sdk@^0.2.128  (NanoClaw upstream)
Entry point:           import { query, tool, createSdkMcpServer, startup } from "..."
Pre-warm:              await startup()  (once per process)
New session:           query({ prompt, options: { ... } })   // no resume
Resume session:        query({ prompt, options: { resume: sessionId } })
Fork session:          query({ prompt, options: { resume: sessionId, forkSession: true } })
Stream tokens:         options.includePartialMessages = true; iterate stream_event
Cancel:                pass abortController; ab.abort() to stop
Hooks:                 options.hooks = { PreToolUse: [{ matcher: regex, hooks: [...] }] }
Subagents (filesystem): .claude/agents/<name>.md (auto-loaded with settingSources: ["project"])
Subagents (inline):    options.agents = { name: { description, prompt, tools, model, maxTurns } }
Custom tools:          tool(name, desc, zodSchema, async (args) => ({ content, isError? })) → createSdkMcpServer({...tools: [...]})
1-hour cache:          env.ENABLE_PROMPT_CACHING_1H = "1"
Cost:                  message.total_cost_usd (estimate), message.modelUsage (per-model)
Permission mode:       bypassPermissions (NanoClaw upstream default; see §6 for security model)
Disallow tool:         disallowedTools: ["Write"]  (bare name removes from context)
Tool naming:           mcp__<server>__<tool>  (e.g., mcp__career-pilot__update_application)
```

---

## 14. URLs to keep handy

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [GitHub TypeScript CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [June 15, 2026 billing change](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
