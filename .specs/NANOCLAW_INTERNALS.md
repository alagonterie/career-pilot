# NanoClaw Internals — How the host machine actually works

> **Purpose:** End the assumption-driven phase. We have vendored NanoClaw as
> the foundation of career-pilot; this document is the primary-source-derived
> understanding of how it works, what it gives us, and where our existing
> specs have drifted. **Read this before any implementation work that depends
> on NanoClaw behavior.**
>
> Written 2026-05-26 against the tree at commit `8cf6e95` (HEAD of
> `nanoclaw-rebuild`). Re-derived directly from `src/`, `container/`, and
> `setup/`. Where I say "the composer" or "the runtime," I mean the
> *upstream NanoClaw* code in this vendored tree — not anything we've built.
>
> Spec status: spec-anchored (see `[[feedback-spec-driven-development]]`).
> Existing implementation: vendored upstream. Treat this doc as the
> contract; if it drifts from `src/` later, fix the doc deliberately.

---

## Definition of done

This spec is "done" when:

1. Every §N has a **"What this means for us"** subsection — no findings
   without implications.
2. §11 lists every assumption in PORTAL.md / STRATEGY.md / RECOVERY.md that
   the source code contradicts, with the specific spec edit each implies.
3. §12 lists every open question — anything I couldn't determine from source
   — and each is tagged with a concrete plan to resolve (operator probe,
   doc read, runtime test).
4. The reader of this doc + the existing four specs has enough to start
   Phase 1 implementation without bluffing on a single load-bearing decision.

---

## §1 Map — the orientation file tree

NanoClaw has two TypeScript trees with separate dep graphs:

- **Host tree** (`src/` + `setup/` + `scripts/`) — Node 20+, pnpm,
  `better-sqlite3`. Long-running daemon. Owns channel adapters, routing,
  container spawn, the central DB, OneCLI gateway wiring.
- **Container tree** (`container/agent-runner/src/`) — Bun runtime,
  `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`. One process
  per container per session. Polls inbound DB, calls the LLM provider,
  writes outbound DB.

The two trees never share code at runtime. They communicate only through
per-session SQLite files (`inbound.db` host-writes / `outbound.db`
container-writes) and a `.heartbeat` file. This is enforced by mount geometry,
not convention.

### Host tree — what lives where

| Path | One-line role |
|---|---|
| `src/index.ts` | Main entry: init DB → run migrations → start channel adapters → start delivery + sweep polls → start CLI server |
| `src/router.ts` | Inbound message routing. Channel-event → messaging group → access gate → resolve session → write to inbound.db → wake container |
| `src/delivery.ts` | Reverse direction: poll outbound.db across all sessions, dispatch to channel adapters |
| `src/host-sweep.ts` | Periodic sweep: heartbeat-stale → kill container; processing-ack stuck → reset; idle ceiling → mark stopped |
| `src/session-manager.ts` | Session folder layout + the two DB invariants (DELETE journal mode, host-opens-closes per op) |
| `src/container-runner.ts` | Container spawn: build mounts, build args, wire OneCLI gateway, `spawn(docker run …)` |
| `src/container-runtime.ts` | Docker/Apple Container binary selection + runtime-level lifecycle |
| `src/claude-md-compose.ts` | **The system prompt composer.** Regenerates `groups/<folder>/CLAUDE.md` on every spawn from the base + fragments + MCP instructions |
| `src/group-folder.ts` | Group folder name validation + path resolution |
| `src/group-init.ts` | Idempotent per-group filesystem init (CLAUDE.local.md, settings.json with PreCompact hook, .claude-shared/skills/) |
| `src/command-gate.ts` | Slash-command classification before container wake (filter / deny / allow) |
| `src/circuit-breaker.ts` | Startup backoff against rapid-restart loops |
| `src/db/connection.ts` | Central DB init + `getDb()` accessor |
| `src/db/migrations/` | Numbered migrations (`001-initial.ts` …); migration object = `{version, name, up(db)}` |
| `src/db/sessions.ts` | Sessions / pending_questions / pending_approvals CRUD |
| `src/db/session-db.ts` | Per-session DB schema + open helpers (`openInboundDb`, `openOutboundDb`, `ensureSchema`) |
| `src/db/agent-groups.ts` | Agent group CRUD |
| `src/db/messaging-groups.ts` | Messaging group + wiring CRUD |
| `src/db/container-configs.ts` | Per-group container config (mcp_servers, skills, packages, image_tag, cli_scope, provider) |
| `src/channels/adapter.ts` | The `ChannelAdapter` interface every channel implements |
| `src/channels/channel-registry.ts` | `initChannelAdapters` / `getChannelAdapter` / `teardownChannelAdapters` |
| `src/channels/chat-sdk-bridge.ts` | Adapter implementation for the `chat` npm package (used by most channels: Telegram, Slack, Discord, Teams, etc.) |
| `src/channels/cli.ts` | The "CLI" channel adapter — admin transport for `ncl` operator commands |
| `src/channels/ask-question.ts` | Generic interactive-question rendering across channel types |
| `src/cli/socket-server.ts` | `ncl` CLI server (UNIX socket at `data/ncl.sock`) |
| `src/cli/registry.ts` | Where `ncl` subcommands self-register |
| `src/cli/dispatch.ts` | Maps `ncl <cmd>` → registered handler |
| `src/modules/index.ts` | Modules barrel — import for side effects (registers hooks at module-scope) |
| `src/modules/approvals/` | The approvals primitive (renders + persists approval cards) |
| `src/modules/permissions/` | Roles + access gates (`setAccessGate`, `setSenderResolver`, `setSenderScopeGate`) |
| `src/modules/agent-to-agent/` | Inter-agent destinations + delivery |
| `src/modules/self-mod/` | The agent can request changes to its own group config; approval-gated |
| `src/modules/scheduling/` | Cron-style scheduled messages |
| `src/modules/interactive/` | Generic interactive primitive |
| `src/modules/typing/` | Typing-indicator refresh during agent work |
| `src/modules/mount-security/` | Additional-mount allowlist validation |
| `src/response-registry.ts` | Question/approval response dispatcher (broken out to avoid circular imports) |
| `setup/` | First-run install wizard + channel pairing flows |
| `scripts/q.ts` | Ad-hoc SQL: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT …"` |

### Container tree — what lives where

| Path | One-line role |
|---|---|
| `container/agent-runner/src/index.ts` | Entry: load `container.json` → build system-prompt addendum → start MCP server child process → run poll loop |
| `container/agent-runner/src/poll-loop.ts` | The agent loop. Read inbound.db → format prompt → `provider.query()` → stream events → write outbound.db |
| `container/agent-runner/src/providers/claude.ts` | Wraps `@anthropic-ai/claude-agent-sdk` `query()`. Owns hooks, allowlist, continuation rotation |
| `container/agent-runner/src/providers/types.ts` | The `AgentProvider` interface providers implement |
| `container/agent-runner/src/destinations.ts` | The `<message to="name">` destination map: who the agent can reply to |
| `container/agent-runner/src/formatter.ts` | Inbound message → XML-wrapped prompt format the agent sees |
| `container/agent-runner/src/mcp-tools/server.ts` | MCP-server bootstrap; `registerTools([...])` self-registration |
| `container/agent-runner/src/mcp-tools/core.ts` | Built-in: `send_message`, `send_file`, `edit_message`, `add_reaction` |
| `container/agent-runner/src/mcp-tools/interactive.ts` | Built-in: `ask_user_question` (blocking, real reply) |
| `container/agent-runner/src/mcp-tools/scheduling.ts` | Built-in: `schedule_task` family |
| `container/agent-runner/src/mcp-tools/agents.ts` | Built-in: agent-to-agent tools |
| `container/agent-runner/src/mcp-tools/self-mod.ts` | Built-in: `update_group_config` / `add_mcp_server` etc. (approval-gated) |
| `container/agent-runner/src/db/messages-in.ts` | Read pending inbound messages |
| `container/agent-runner/src/db/messages-out.ts` | Write outbound replies |
| `container/agent-runner/src/db/session-state.ts` | The continuation token store (per-provider) |
| `container/agent-runner/src/compact-instructions.ts` | Called by PreCompact hook to inject extra instructions before context compaction |
| `container/CLAUDE.md` | **The shared base system prompt** — RO-mounted at `/app/CLAUDE.md` into every container, every group |

### What this means for us

- **The MCP server in the container is the integration point.** Our 6 Phase 1
  tools all belong as files in
  `container/agent-runner/src/mcp-tools/career-pilot/` (or as one
  consolidated module) following the `registerTools([...])` self-registration
  pattern. Adding a new tool is: write the file, call `registerTools`,
  append one import line in `mcp-tools/index.ts`.
- **The destination model determines reply routing.** When we wire the agent
  to multiple channels (Telegram owner thread, future Portal SSE), each
  becomes a named destination the agent picks via `<message to="…">`.
- **The two-tree split means the persona is rendered on the host side**
  but read on the container side via mount geometry. The host writes
  `groups/career-pilot/CLAUDE.local.md` (or a fragment); the container reads
  it via `/workspace/agent/CLAUDE.local.md`. We never need IPC for this.

---

## §2 Session model — the answer to "what is a session"

A session is a **persistent row** in `data/v2.db` (`sessions` table) keyed
on `(agent_group_id, messaging_group_id, thread_id)`. Once created, it
**lives forever** until explicitly deleted (no automatic TTL, no idle
expiry).

### Three session modes

Picked at wiring time per `messaging_group_agents.session_mode`:

| Mode | Behavior |
|---|---|
| `shared` | One session per (agent group, messaging group). Threads merge. |
| `per-thread` | One session per (agent group, messaging group, thread). Each thread isolated. |
| `agent-shared` | One session per agent group, across all messaging groups. Cross-channel one-brain. |

The router's `deliverToAgent()` resolves the right session via
`resolveSession()` in `src/session-manager.ts:92`, creating it on first
contact.

### Container lifecycle is independent of session lifecycle

- **Session row**: created on first inbound, persists forever.
- **`session.status`**: `'active'` for normal use; flipped only by admin action.
- **`session.container_status`**: `'stopped'` (default) → `'running'` (on wake) → `'stopped'` (on container exit). Updated by `markContainerRunning` / `markContainerIdle` / `markContainerStopped` in `session-manager.ts`.

The **container is spawned on-demand** when inbound routing fires
`wakeContainer()` (`src/router.ts:472`). A container that's already running
is no-op'd; a wake-in-flight Promise dedupes concurrent wakes
(`container-runner.ts:63`).

The container **stops itself** on natural exit; the host kills it via
`host-sweep.ts` when:

- Heartbeat file (`<session-dir>/.heartbeat`) goes stale (no touch for some interval — operator-tunable)
- A `processing_ack` row in outbound.db has been claimed too long without progress
- An overall idle ceiling fires (default per upstream env)

### Resume + continuation

The Claude provider persists the SDK session id in the container-owned
`session_state` table (key `continuation:claude`) via `setContinuation()`
on the first SDK `init` event. On next container wake:

1. `poll-loop.ts` reads the stored continuation.
2. Hands it to `provider.query({ continuation, … })`.
3. The SDK reloads the underlying `.jsonl` transcript and Claude resumes
   with full prior context.
4. `maybeRotateContinuation()` runs first — if the transcript exceeds
   `CLAUDE_TRANSCRIPT_ROTATE_BYTES` (default 12 MB) or
   `CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS` (default 14), archive a markdown
   summary into `groups/<folder>/conversations/` and start fresh.

**So sessions are conceptually infinite-lived, conversations resume across
container restarts, and transcripts auto-rotate before they become too
expensive to cold-resume.**

### Cross-mount SQLite invariants (load-bearing)

`session-manager.ts` opens-writes-closes per op. Three rules MUST hold or
the container silently misses every message:

1. `journal_mode = DELETE` (not WAL) — WAL's mmapped -shm doesn't refresh host→guest.
2. Host opens-writes-CLOSES per op — close invalidates the container's page cache.
3. One writer per file — DELETE-mode journal-unlink isn't atomic across the mount.

These are why we have **two DBs** (`inbound.db` host-writes,
`outbound.db` container-writes) instead of one shared one.

### What this means for us

- **Our `persona.local.md` worry was misplaced.** Containers spawn fresh on
  every wake. Wakes happen on every inbound trigger. For a typical thread
  with multi-hour gaps between messages, that's many spawns per day → many
  persona regenerations per day. Staleness is essentially free to manage:
  always re-render at compose time and forget about manual reloads.
- **Conversational continuity is free.** We don't need to build any
  history-replay mechanism for the candidate ↔ agent thread — Claude
  resumes the transcript on every wake.
- **Long-running tools need heartbeat awareness.** If we have an MCP tool
  that takes >30s, it must either run asynchronously (return immediately,
  notify via inbound) or live with the host-sweep stale-tolerance window.
  Bash declares its timeout via `tool_declared_timeout_ms` and the sweep
  widens its kill window. Our MCP tools should follow the same pattern.
- **No new session model needed for career-pilot.** `agent-shared` already
  gives us "one brain across all channels" — the candidate's Telegram
  thread, our hypothetical Portal SSE, and a debug `ncl chat` all hit the
  same brain. No need to invent anything.

---

## §3 Container model — spawn, mounts, comms

### Spawn args (the actual command line)

`buildContainerArgs()` in `container-runner.ts:399` assembles:

```
docker run --rm --name nanoclaw-v2-<folder>-<ts> --label <install_label>
  -e TZ=<tz>
  [-e <provider-env-vars>]
  <OneCLI gateway env + cert mounts>     ← from onecli.applyContainerConfig()
  --add-host host.docker.internal:host-gateway
  [--user <hostUid>:<hostGid> -e HOME=/home/node]
  <volume mounts>                        ← see below
  --entrypoint bash
  <image-tag>                            ← container_configs.image_tag || CONTAINER_IMAGE
  -c "exec bun run /app/src/index.ts"
```

**OneCLI is hard-required.** `container-runner.ts:431`:

```ts
if (!onecliApplied) {
  throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
}
```

There is no path to spawn without OneCLI. Even local dev needs OneCLI
running.

### Mount layout

Each container sees:

| Container path | Host source | RW? | Purpose |
|---|---|---|---|
| `/workspace` | `data/v2-sessions/<agent_group_id>/<session_id>/` | RW | Session folder (inbound.db, outbound.db, .heartbeat, outbox/) |
| `/workspace/agent` | `groups/<folder>/` | RW | Group dir (CLAUDE.local.md, working files) |
| `/workspace/agent/container.json` | `groups/<folder>/container.json` | RO | Per-group config (nested RO over RW) |
| `/workspace/agent/CLAUDE.md` | `groups/<folder>/CLAUDE.md` | RO | **Composed by host on every spawn** — agent cannot edit |
| `/workspace/agent/.claude-fragments` | `groups/<folder>/.claude-fragments/` | RO | Composer-managed fragment imports |
| `/workspace/global` | `groups/global/` | RO | Shared cross-group memory (when present) |
| `/app/CLAUDE.md` | `container/CLAUDE.md` (project root) | RO | Shared base system prompt |
| `/app/src` | `container/agent-runner/src/` | RO | Agent runner source — Bun runs TS directly, no build |
| `/app/skills` | `container/skills/` | RO | Shared skills (each `<skill>/SKILL.md`) |
| `/home/node/.claude` | `data/v2-sessions/<agent_group_id>/.claude-shared/` | RW | Claude SDK state, settings.json, skill symlinks |

Additional mounts come from `container_configs.additionalMounts` (validated
against `data/mounts-allowlist.json`) and provider contributions.

### Host ↔ container communication

**No stdin, no stdout markers, no IPC files.** Everything goes through:

- `inbound.db` (`/workspace/inbound.db`) — host writes `messages_in`, `destinations`, `session_routing`; container reads.
- `outbound.db` (`/workspace/outbound.db`) — container writes `messages_out`, `processing_ack`, `session_state`, `container_state`; host reads.
- `.heartbeat` (`/workspace/.heartbeat`) — container touches periodically; host watches mtime for liveness.
- `inbox/<message-id>/` (`/workspace/inbox/...`) — host stages base64 attachments from inbound messages; agent reads as `localPath`.
- `outbox/<message-id>/` (`/workspace/outbox/...`) — container writes outbound attachments; host reads + delivers + cleans up.

The container's stdout is unused. stderr is captured by host as debug logs.

### Provider abstraction

In-container abstraction at `container/agent-runner/src/providers/`. Default
is `claude` (`providers/claude.ts`) using `@anthropic-ai/claude-agent-sdk`.
Skills `add-codex` / `add-opencode` / `add-ollama-provider` swap in
different providers without touching the rest of the runner.

### What this means for us

- **OneCLI is a hard dependency, not optional.** Our `PORTKEY_BYPASS=true`
  fallback strategy needs reconciliation. Most likely interpretation: the
  Anthropic API key is the *only* credential routed through Portkey;
  Portkey's vault is bypassed via env, but OneCLI's vault still handles
  Gmail/Calendar/etc. credentials and HTTP-proxy injection. We can't
  bypass OneCLI itself.
- **`/workspace/agent` is the agent's writable workspace.** Anything we
  drop in `groups/career-pilot/` is visible to the agent at
  `/workspace/agent/`. The candidate-profile-rendered persona belongs
  here, not in `data/`.
- **No build step for the agent runner.** Bun runs TS directly. Our MCP
  tools (TS files) get picked up at next container spawn with no
  intermediate build. Fast iteration.
- **The provider abstraction lets us swap or extend the LLM stack without
  touching the message loop.** Long-term, this is where Portkey
  integration would live (intercept the SDK config to point at Portkey's
  proxy + add the Portkey headers).
- **Heartbeat-based liveness is a constraint on long-running MCP tools.**
  An MCP tool that hangs without producing SDK events will eventually be
  killed by host-sweep. Plan for this.

---

## §4 Group system — composition + the CLAUDE.md trap

This is the section that overturns the most assumptions.

### Layered system prompt

The full system prompt assembled for any container = **base + fragments + per-group memory + runtime addendum**:

1. **Base** — `container/CLAUDE.md` (RO at `/app/CLAUDE.md`). Workspace
   conventions, the memory model, how the agent should think about
   CLAUDE.local.md. Same for every agent in NanoClaw.
2. **Skill fragments** — every shared skill that ships an
   `instructions.md` (e.g. `container/skills/add-telegram/instructions.md`)
   becomes an import in the composed file.
3. **MCP-tool fragments** — every file in
   `container/agent-runner/src/mcp-tools/<name>.instructions.md` becomes
   an import (e.g. `scheduling.instructions.md`). These describe how the
   agent should use that family of tools.
4. **MCP-server fragments** — for user-added external MCP servers, the
   `container.json[mcpServers].<name>.instructions` field is written as a
   text file and imported.
5. **Per-group memory** — `CLAUDE.local.md` in the group dir, auto-loaded
   by Claude Code. The agent **can write** to this file (auto-memory is
   enabled by default via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` in
   `group-init.ts:13`).
6. **Runtime addendum** — `buildSystemPromptAddendum()` in
   `destinations.ts` produces a per-turn string with agent name +
   destination list. Passed via `systemContext.instructions` and appended
   to the Claude Code preset.

### The composer is the boss of `groups/<folder>/CLAUDE.md`

`composeGroupClaudeMd()` in `claude-md-compose.ts` runs **on every container
spawn** (`buildMounts()` calls it at line 261). It:

1. Symlinks `.claude-shared.md` → `/app/CLAUDE.md`.
2. Builds the **desired fragment set** from skills + MCP tool source +
   `container.json[mcpServers].instructions`.
3. **Prunes stale fragments** — any file in `.claude-fragments/` not in
   the desired set is `fs.unlinkSync`'d.
4. Writes desired fragments (symlinks or inline content).
5. Writes `groups/<folder>/CLAUDE.md` as a fresh file containing only
   `@./` imports — composed header + import lines, nothing else.
6. Creates empty `CLAUDE.local.md` if missing (never touches it
   afterwards — that's agent-writable territory).

**The composed `CLAUDE.md` is then mounted RO into the container** so the
agent physically can't edit it.

**The composed `CLAUDE.md` will never contain author-written content.**
Anything we hand-write there is *destroyed on first spawn*.

### Where author-written content lives instead

| Location | Survives spawn? | Composed in? | Notes |
|---|---|---|---|
| `groups/<folder>/CLAUDE.md` | NO (rewritten) | (it IS the composed file) | Author content lost |
| `groups/<folder>/CLAUDE.local.md` | YES (init-once) | YES (auto-loaded by Claude Code) | Agent may write to it (auto-memory) |
| `container/CLAUDE.md` | YES | YES (base prompt) | Shared across ALL groups |
| `container/skills/<skill>/instructions.md` | YES | YES (if skill is in the group's selection) | Shared across all groups using that skill |
| `container/agent-runner/src/mcp-tools/<name>.instructions.md` | YES | YES (always, for all groups) | Shared across all groups |
| `container.json[mcpServers].<name>.instructions` | YES (in DB) | YES (inline) | Per-group config |

There is **no built-in "host-rendered per-group persona" slot.** The
composer doesn't know about candidate-profile-style host fragments.

### Subagent definitions (Claude Code Teams)

`groups/<folder>/.claude/agents/*.md` is the standard Claude Code subagent
location. Mounted to `/workspace/agent/.claude/agents/` and discovered by
Claude Code automatically because `settingSources: ['project', 'user',
'local']` is set AND each file's YAML frontmatter includes a `name:` field
(the load-bearing requirement — without it the file is silently skipped
during scan; see [AGENT_SDK_PATTERNS.md §3](AGENT_SDK_PATTERNS.md) for the
canonical-docs-derived breakdown). Earlier drafts of this section claimed
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` was also required; that was wrong
for CLI 2.1.128 — verified empirically.

So our existing five subagent stub files at
`groups/career-pilot/.claude/agents/{research-company,tailor-resume,…}.md`
need `name:` in their frontmatter to be discoverable — added 2026-05-26.

### Group folder validation

`group-folder.ts` enforces:

- `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` only
- No `..`, no slashes, no leading/trailing whitespace
- `global` is reserved (shared memory dir)

Our `career-pilot` and `career-pilot-sandbox` folder names are valid.

### What this means for us

**Spec delta — the big one.** Our Phase 1 commit `cf293f0` ("Phase 1: Write
owner agent persona") wrote a fully-authored
`groups/career-pilot/CLAUDE.md`. **That file will be deleted and
overwritten the first time we spawn a container against this group.** We
have a choice of strategies (cf. §11 for the decision):

- **Strategy A — Persona as `CLAUDE.local.md`.** Move all persona content
  to `groups/career-pilot/CLAUDE.local.md`. Pros: uses NanoClaw's
  intended mechanism, survives spawn, auto-loaded by Claude Code. Cons:
  agent auto-memory writes to the same file → the agent could overwrite
  pieces of our authored content. Mitigation: disable auto-memory for
  this group (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` per-group), or carve
  out a `# Read-only — managed by host` sentinel section the agent is
  trained to leave alone.
- **Strategy B — Persona as a host-injected fragment.** Modify the
  composer to look for `groups/<folder>/.claude-host-fragments/*.md` and
  include them in the composed import list, alongside skill + MCP-tool
  fragments. Pros: clean separation between host-rendered (persona) and
  agent-written (`CLAUDE.local.md`) content. Cons: requires modifying
  upstream NanoClaw code (manageable — we're a clone-and-customize
  fork). Tracking deviation for future `/update-nanoclaw` runs.
- **Strategy C — Persona as a fake MCP-server `instructions` field.**
  Stuff the rendered persona into `container.json[mcpServers].persona.instructions`
  with a no-op server. Pros: works without touching the composer. Cons:
  ugly, abuses the mechanism, and the per-MCP-server instruction is
  arguably meant to describe how to use *that server's tools*.

**Strategy B is the clean answer** — small, principled extension that
matches NanoClaw's own pattern. **Implemented** in the second of the
NanoClaw-deep-dive commit set:

- `src/claude-md-compose.ts` now scans `groups/<folder>/.claude-host-fragments/`
  for `*.md` files and adds them to the composed `CLAUDE.md` import list
  alongside skill + MCP-tool fragments. The composer does NOT prune the
  directory — it's externally owned (by host-side pre-spawn render hooks
  and by anything committed in the group dir).
- `src/container-runner.ts` mounts the directory RO into the container
  at `/workspace/agent/.claude-host-fragments/`, so the in-container
  agent cannot modify host-rendered content.
- Per-deployment candidate-specific content (PII-bearing) goes in
  `candidate.md`, gitignored. Authored persona goes in `persona.md`,
  committed. Both get composed in via the same `@./` import mechanism.

This is our **first deliberate deviation from upstream NanoClaw** — track
for future `/update-nanoclaw` runs. The change is additive (a new
directory the composer recognizes) so upstream pulls that touch
`claude-md-compose.ts` should re-apply cleanly via 3-way merge.

**The `persona.local.md` filename was naive.** It would never have been
loaded automatically. The actual model is either CLAUDE.local.md (named
exactly that, no choice) or a composer-imported fragment via our
extension (any name we want).

**Subagent definitions need no change.** Our 5 stub files at
`groups/career-pilot/.claude/agents/` are in the right place.

---

## §5 Hook / extension surface — every place we can inject behavior

### Host-side hooks (TypeScript registrations)

All registered at module-import time via `src/modules/index.ts`. New
modules (added by skills) append imports there.

| Hook | Registered by | Fires when | Used for |
|---|---|---|---|
| `setSenderResolver` | permissions | Before agent resolution in `routeInbound` | Upsert users row, namespace ids |
| `setAccessGate` | permissions | After agent resolution | Policy-based allow/deny |
| `setSenderScopeGate` | permissions | Per-wiring during fan-out | Enforce `sender_scope='known'` |
| `setMessageInterceptor` | permissions | Top of `routeInbound`, before MG lookup | Capture free-text approval replies |
| `setChannelRequestGate` | permissions | When mention/DM lands on unwired channel | Owner approval card for new channel |
| `registerResponseHandler` | various | When channel adapter dispatches a button/menu response | Multi-handler chain, first that claims wins |
| `onShutdown` | various | SIGTERM/SIGINT | Graceful module teardown |
| `registerCommand` | various | `ncl <cmd>` arrival via CLI socket | Add operator commands |
| `registerProvider` | container-side providers | Container startup | Add LLM provider |

### Container-side hooks (Claude SDK + provider hooks)

| Hook | Defined in | Fires when | Used for |
|---|---|---|---|
| `PreToolUse` | `providers/claude.ts:161` | SDK is about to invoke a tool | Block disallowed tools (defense-in-depth); record `tool_declared_timeout_ms` for host-sweep stuck-tolerance |
| `PostToolUse` | `providers/claude.ts:183` | Tool returned | Clear `container_state.current_tool` |
| `PostToolUseFailure` | `providers/claude.ts` | Tool threw | Same as PostToolUse |
| `PreCompact` | `providers/claude.ts:236` | SDK about to compact context | Archive transcript to `groups/<folder>/conversations/<date>-<slug>.md` |

The PreCompact hook is also registered via `settings.json` (see
`group-init.ts:18`) as a Claude Code command-type hook running
`bun /app/src/compact-instructions.ts`. The SDK-registered hook and the
settings-registered hook coexist.

### Composer extension point (does not exist yet, would be ours)

`composeGroupClaudeMd()` does not currently support author-defined
fragments. Adding support would be ~20 lines: read
`groups/<folder>/.claude-host-fragments/*.md` and include them in the
desired set as `inline` fragments (host writes the content; composer
copies into `.claude-fragments/` and imports). This is the Strategy B
work proposed in §4.

### MCP tool registration (the canonical way to extend agent capability)

In `container/agent-runner/src/mcp-tools/<your-module>.ts`:

```ts
import { registerTools } from './server.js';

registerTools([
  {
    tool: { name: 'analyze_jd', description: '…', inputSchema: { … } },
    handler: async (args) => { /* … */ return { content: [{ type: 'text', text: '…' }] }; }
  },
]);
```

Then add one import to `mcp-tools/index.ts`. No barrel manipulation,
nothing else.

### Skill registration (operator-driven)

Skills under `.claude/skills/<name>/SKILL.md` are user-facing operator
extensions, not agent-runtime extensions. They're invoked by the operator
saying e.g. "/add-telegram" and rewrite NanoClaw config. The
`update-nanoclaw` skill is how we'll pull upstream updates.

### What this means for us

- **Three places to add agent capability**, in order of impact:
  1. MCP tools (in-container, per-group, full SDK + host DB access via
     the `nanoclaw` server's bookkeeping).
  2. Composer fragments (when we want to ship per-tool guidance to the
     agent about how to use the tools — `<name>.instructions.md`).
  3. Skills (operator-facing config extensions; not what we usually
     want).

- **Our `update_application`, `record_funnel_event`, etc. tools all go in
  one new file**, e.g. `mcp-tools/career-pilot/index.ts`, with a sibling
  `career-pilot/index.instructions.md` (or per-tool `.instructions.md`
  files; the composer picks them all up if they match the
  `<name>.instructions.md` glob).

- **The "owner approves irreversible actions" pattern (per persona spec)
  routes through the approvals module.** That module is already
  registered at host startup. Our MCP tools call into the approvals
  primitive to enqueue an approval card and block until the operator
  responds. This is how the existing `self-mod` tools work — read
  `mcp-tools/self-mod.ts` for the pattern when we get to Phase 2.

---

## §6 Channel adapter contract

### The interface (`src/channels/adapter.ts`)

Every channel implements `ChannelAdapter`:

- `channelType: string` — unique key (`'telegram'`, `'slack'`, etc.)
- `supportsThreads: boolean` — drives router thread policy (non-threaded adapters collapse to channel-level sessions)
- `init(setup): Promise<void>` — receive `onInbound` / `onInboundEvent` / `onMetadata` / `onAction` callbacks from the host
- `deliver(platformId, threadId, { kind, content, files? }): Promise<string | undefined>` — send outbound, return platform message ID
- `setTyping?(platformId, threadId): Promise<void>` — typing indicator
- `subscribe?(platformId, threadId): Promise<void>` — for `mention-sticky` engagement on threaded platforms

Most channels delegate to the `chat` npm package via `chat-sdk-bridge.ts`.
This is the "Chat SDK" referred to in the upstream skills. Direct adapters
(Telegram via native API, WhatsApp via Baileys, Signal via signal-cli)
exist for cases where the `chat` package doesn't cover.

### Engagement model

`messaging_group_agents.engage_mode` per wiring:

- `pattern` — regex against text; `'.'` = always
- `mention` — platform mention required (SDK-level isMention)
- `mention-sticky` — mention OR existing per-thread session for this agent (the session itself is the "subscription state")

Fan-out: multiple agents wired to the same MG each evaluate engagement
independently and either engage (own session + container) or accumulate
(silent context-store) or drop.

### Output protocol — `<message to="name">`

**Critical discovery, undocumented in our specs.** From
`poll-loop.ts:495`:

```ts
const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
```

The agent's final response text is parsed for `<message to="name">…</message>`
blocks. Each block is dispatched to the named destination (channel or
sister agent). Text outside blocks is **scratchpad only** — logged but
not sent. `<internal>…</internal>` tags are stripped from scratchpad
logging.

If the agent produces only bare text, the runner pushes a `<system>`
nudge into the active query telling the agent to re-wrap, listing the
known destinations. One nudge per stream.

### Destination map

`destinations.ts` reads `inbound.db.destinations` (host-managed) at every
lookup. Host writes destinations on every container wake via
`writeSessionRouting()` + `writeDestinations()` from the agent-to-agent
module. Sister agents in the same wiring show up; channels the agent is
wired to show up.

### Default reply routing

If the agent uses `mcp__nanoclaw__send_message` without specifying a
destination, the runner falls back to `session_routing` (the row written
on every wake with the source thread). Same fallback applies to
`ask_user_question`.

### What this means for us

- **The persona MUST internalize `<message to="…">`.** This is a
  non-negotiable runtime contract; every reply needs to be wrapped. Our
  current persona at `groups/career-pilot/CLAUDE.md` (which is going to
  be moved per §4) doesn't mention this. Has to be added.
- **The `<internal>` scratchpad** is exactly what the persona's
  "Reflection prompting" needs. The agent can deliberate in
  `<internal>…</internal>` blocks safely without those reaching the
  candidate or the public portal.
- **Multi-channel routing is solved.** When we add the Portal SSE
  "channel" in Phase 5, it becomes another `ChannelAdapter` and a new
  destination the agent picks via `<message to="portal">`. No new
  abstraction needed.
- **Telegram-specific work for Phase 1** is just `/add-telegram` skill +
  pairing. No code changes to the adapter layer. The chat-sdk-bridge
  handles it.
- **Sanitization timing.** Per PORTAL.md, sanitization runs on the
  *path to the portal*, not on outbound to Telegram. Cleanest place is
  inside the Portal channel adapter's `deliver()`, before SSE broadcast.
  No changes to other adapters.

---

## §7 Database layer

### Three tiers of database

| Tier | File(s) | Owner | Schema source |
|---|---|---|---|
| Central | `data/v2.db` | Host (long-lived connection via `getDb()`) | `src/db/migrations/*.ts` |
| Inbound (per session) | `data/v2-sessions/<agent-group-id>/<session-id>/inbound.db` | Host writes, container reads | `INBOUND_SCHEMA` in `src/db/schema.ts` |
| Outbound (per session) | `data/v2-sessions/<agent-group-id>/<session-id>/outbound.db` | Container writes, host reads | `OUTBOUND_SCHEMA` in `src/db/schema.ts` |

The per-session DBs are created fresh by `initSessionFolder()` when a
session row is created. They never run versioned migrations — they're
recreated cleanly per session. There's a small `migrateMessagesInTable()`
helper that adds columns idempotently on every host open (for handling
the `source_session_id` / `on_wake` columns added later in v2's life).

### Central schema (`v2.db`)

Tables we care about (full list in `src/db/schema.ts`):

| Table | Owns |
|---|---|
| `agent_groups` | The group identity (`career-pilot`, `career-pilot-sandbox`) |
| `messaging_groups` | Discovered channels/chats (one Telegram thread = one row) |
| `messaging_group_agents` | The wirings (agent ↔ channel ↔ engage rules) |
| `users` | Namespaced sender identifiers (`tg:123`, `email:x@y.com`) |
| `user_roles` | Owner / admin grants |
| `agent_group_members` | "Known sender" lists per group |
| `user_dms` | Cached user→DM messaging-group resolution |
| `sessions` | All session rows (see §2) |
| `pending_questions` | In-flight `ask_user_question` cards |
| `pending_approvals` | In-flight approval cards (used by self-mod, OneCLI cred requests) |
| `pending_sender_approvals` | Approval cards for unknown senders |
| `pending_channel_approvals` | Approval cards for unwired channels |
| `dropped_messages` | Audit trail for refused/silenced inbound (router structural drops + gate refusals) |
| `container_configs` | Per-group container config (mcp_servers, skills, packages, image_tag, cli_scope, provider) |
| `agent_destinations` | Inter-agent destination definitions (from agent-to-agent module) |

Career-pilot's added tables (migrations 100-107 — `7569f50`):
`applications`, `application_history`, `funnel_events`, `outreach`,
`interviews`, `learnings`, `public_audit_trail`, `simulator_runs`,
`candidate_profile`, `preferences`, `system_modes`.

These coexist cleanly in `v2.db`. Same DB, same connection. Our
migrations sit at versions 100+ deliberately to give upstream room (001-099
range).

### Migration interface

```ts
export interface Migration {
  version: number;        // monotonic integer
  name: string;           // unique (the dedup key)
  up(db: Database.Database): void;
}
```

`migrations` array in `src/db/migrations/index.ts` is the ordering source.
The runner reads `applied_migrations` (auto-created if absent) and runs
any not-yet-applied entries. **Dedup key is `name`, not `version`**, so
renaming a migration after it's been applied breaks idempotency. Don't
rename.

### Ad-hoc queries

`pnpm exec tsx scripts/q.ts data/v2.db "SELECT …"` — the NanoClaw
convention. Read-only by default; pass `-w` to enable writes.

### What this means for us

- **Our migrations 100-107 will run on next host start** — they're
  registered in the migrations array (commit `7569f50`). First start
  after pulling this branch will create our 11 career-pilot tables.
- **No per-session migration concerns for our tables** — career-pilot
  data lives in the central `v2.db`, not per-session.
- **The `applied_migrations` table is the source of truth for what's
  installed.** If we want to verify our migrations landed:
  `scripts/q.ts data/v2.db "SELECT name FROM applied_migrations WHERE
  name LIKE 'career-pilot%'"`.
- **Session DB schemas are not extensible.** If we ever want
  per-session state (we probably don't), we'd need a different mechanism.
  All career-pilot state is global per-agent-group, which fits the
  central DB.

---

## §8 MCP tools + subagent registration

### MCP tool surface (in-container)

The container's `mcp-tools/server.ts` runs an MCP server over stdio
inside the agent-runner process. It's started as a child process of the
agent-runner (`bun run /app/src/mcp-tools/index.ts`). The Claude SDK
talks to it via the `mcpServers.nanoclaw = { command: 'bun', args: ['run',
mcpServerPath], env: {} }` config in `agent-runner/src/index.ts:77`.

### What the agent gets out of the box

From the imports in `mcp-tools/index.ts`:

- `mcp__nanoclaw__send_message` — outbound chat (the canonical reply path)
- `mcp__nanoclaw__send_file` — outbound with attachment
- `mcp__nanoclaw__edit_message` — edit a previously-sent message
- `mcp__nanoclaw__add_reaction` — react to a chat message
- `mcp__nanoclaw__ask_user_question` — blocking interactive question (real reply)
- `mcp__nanoclaw__schedule_task` — durable cron-style scheduling
- (agents) inter-agent dispatch tools
- (self-mod) `update_group_config`, `add_mcp_server`, etc. — approval-gated

These are all wired into the destination map and the channel-adapter
delivery path. We do **not** reimplement them — we extend.

### Tool allowlist (from `providers/claude.ts:43`)

The SDK is told to allow:

```
Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch,
Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage,
TodoWrite, ToolSearch, Skill, NotebookEdit
+ mcp__<server>__* for every registered server (dynamic)
```

And disallow (from `providers/claude.ts:26`):

```
CronCreate, CronDelete, CronList, ScheduleWakeup, AskUserQuestion,
EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree
```

The disallow list is *defense-in-depth* enforced by the `PreToolUse` hook
that returns `decision: 'block'` if the SDK tries to run one of them.

### Permission mode (critical contradiction with our locked decision)

`providers/claude.ts:416`:

```ts
permissionMode: 'bypassPermissions',
allowDangerouslySkipPermissions: true,
```

NanoClaw runs Claude with `bypassPermissions`. Our locked decision
(`decision-architecture` memory) says:

> **`bypassPermissions` mode in Claude Agent SDK** — never use. Use
> `default` + `canUseTool` callback (owner) or `dontAsk` + explicit
> `disallowedTools` (sandbox).

This is a direct contradiction. The locked decision was made before we
read NanoClaw's source. Two ways to reconcile (see §11):

- **Accept NanoClaw's bypassPermissions** and rely on:
  - `disallowedTools` to block unsafe SDK builtins (already done)
  - `PreToolUse` hook for additional gating
  - The approvals module + host-side approval cards for irreversible
    actions (the existing pattern for self-mod)
  - The container's mount RO/RW geometry as the actual security boundary
- **Override the provider** in our fork. Either:
  - Add a `career-pilot` provider variant that uses
    `default` + `canUseTool` callback
  - Modify the upstream `claude.ts` provider directly (clone-and-customize)

The second option is more spec-purist but loses NanoClaw's pattern of
"trust the agent inside the container, control via mounts + approvals."

### Subagent definitions

Standard Claude Code `.claude/agents/<name>.md`. Loaded from
`/workspace/agent/.claude/agents/` (i.e., `groups/<folder>/.claude/agents/`)
because `settingSources: ['project', 'user', 'local']` is set AND each
file's frontmatter includes a `name:` field (load-bearing per
[AGENT_SDK_PATTERNS.md §3](AGENT_SDK_PATTERNS.md)).

Our 5 subagent stubs from Phase 0 now have `name:` fields and are
discovered automatically.

Restrictions: subagents inherit the parent's tool allowlist. There's no
mechanism to give a subagent a smaller palette than the parent (other
than via the subagent's prompt asking it to use only certain tools — soft
constraint).

### What this means for us

- **`mcp-tools/career-pilot/` is the right home** for our 6 Phase 1
  tools. They auto-register via `registerTools([...])`. Add one import
  to `mcp-tools/index.ts` to wire them in.
- **Owner approval for irreversible actions** (per the persona spec)
  → use the approvals primitive, same pattern as self-mod tools. Don't
  invent new gating.
- **The `bypassPermissions` situation is the largest spec-delta** —
  resolution flagged in §11.
- **Subagent restrictions are soft.** We can't technically prevent a
  subagent from using `Bash`. We rely on the subagent prompt to scope
  behavior, plus the read-only intent baked into each subagent's
  description.

---

## §9 OneCLI integration

### What OneCLI does in this architecture

OneCLI runs as a separate process (typically systemd-managed or
PM2-managed). It exposes an HTTP API; NanoClaw talks to it via
`@onecli-sh/sdk`. `onecli.ensureAgent({ name, identifier })` registers our
agent group as a vault scope. `onecli.applyContainerConfig(args, …)`
appends Docker args to the container spawn — specifically:

- Sets `HTTPS_PROXY` / `HTTP_PROXY` env in the container to point at
  OneCLI's local gateway
- Mounts the OneCLI cert chain into the container so TLS to its proxy
  validates
- Sets up a host-mapping for the gateway

When the agent inside the container makes an HTTPS call, it hits the
OneCLI proxy. OneCLI looks at the destination host + the agent identifier
+ the configured credentials for that scope and **injects the right
credential** (Bearer token, basic auth, OAuth-refreshed access token,
etc.) before passing the request upstream.

The container itself never sees raw credentials. They live in OneCLI's
vault on the host.

### Required for every container

`container-runner.ts:431` — `onecliApplied = false` → throw. There is no
"OneCLI disabled" mode. Setup will install OneCLI if absent.

### What this means for us

- **Our Anthropic API key still goes through OneCLI** — it just gets
  injected when the container hits `api.anthropic.com`. Portkey doesn't
  change this. If we route through Portkey, OneCLI injects the Portkey
  key for `api.portkey.ai/v1/messages` (or wherever); Portkey's own
  vault handles the Anthropic key from there.
- **Gmail / Google Calendar OAuth is OneCLI-managed.** Per the
  `/add-gmail-tool` and `/add-gcal-tool` skills. We don't write OAuth
  flows; we register the scope via the skill, and the agent calls Gmail
  as if it's authenticated.
- **`PORTKEY_BYPASS=true` does NOT bypass OneCLI.** It bypasses Portkey
  *as a gateway*, falling back to direct Anthropic API calls — still
  through OneCLI's vault for the API key. Spec-delta candidate (§11)
  for STRATEGY.md to clarify.
- **Cloudflare API token + GCP service account** — same model. OneCLI
  vault scope per service, injected per request.

---

## §10 Operator surface

### `ncl` CLI

Entry point: `bin/ncl` shim → `tsx src/cli/client.ts` → connects to
the UNIX socket at `data/ncl.sock` (server started by `src/index.ts:178`).

Subcommands self-register via `src/cli/registry.ts`. Categories so far
(from `src/cli/resources/`): approvals, destinations, dropped-messages,
groups, members, messaging-groups, roles, sessions, user-dms, users,
wirings.

Pattern is `ncl <resource> <verb> [args]` — `ncl sessions list`,
`ncl wirings add`, `ncl groups show career-pilot`, etc.

### What's already there for "kill switch" / "halt" semantics

Reading the resource files (`src/cli/resources/sessions.ts` etc.) will
confirm specifics, but at a high level NanoClaw has:

- **Session-level**: `ncl sessions kill <id>` (kills container, leaves
  session row), `ncl sessions delete <id>` (removes session entirely)
- **Wiring-level**: enable/disable wirings without deleting them
- **Container-runtime-level**: `cleanupOrphans()` runs on host start to
  kill any nanoclaw-labeled containers from a previous run

What NanoClaw does **not** have built-in (per our RECOVERY.md plan):

- **`/halt`** (pause writes everywhere; queue inbound; flush on resume) —
  not present. Has to be built.
- **`/pause`** (block proactive briefings only) — not present. Has to
  be built; lives in our `system_modes` table.
- **`/killswitch`** (nuclear — kill containers, freeze everything, no
  recovery without operator action) — partial coverage via session kill
  + container kill, but the "freeze all outbound including pending
  questions" behavior has to be built.

### Dashboard

`/add-dashboard` skill installs `@nanoco/nanoclaw-dashboard` + a periodic
JSON snapshot pusher. We can opt into this for visibility, but it's
optional.

### What this means for us

- **Phase-9 RECOVERY.md operator commands need building.** Mostly in
  the `nanoclaw` MCP server (so the operator can also trigger via chat)
  + corresponding `ncl` subcommands. The `system_modes` table is
  already in place (migration 105).
- **`ncl sessions kill <id>`** is good enough as an emergency-stop on a
  per-conversation basis. We don't need to rebuild that.
- **The `/add-dashboard` skill is a nice-to-have** for Phase 9-10. Not
  blocking.

---

## §11 Spec deltas — what we need to fix in PORTAL / STRATEGY / RECOVERY

The audit. Each item:

- **Symptom** — what the current spec says or implies.
- **Reality** — what NanoClaw actually does.
- **Action** — the specific spec edit.

### Δ1 — `bypassPermissions` is NanoClaw's default

- **Symptom.** `decision-architecture` memory + `STRATEGY.md` §6
  "Permission modes" both state "never `bypassPermissions`; use
  `default` + `canUseTool`." `AGENT_SDK_PATTERNS.md` likely echoes this.
- **Reality.** `providers/claude.ts:416` sets
  `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions:
  true`. NanoClaw's security model assumes the container itself + the
  approvals module are the real boundary, not in-SDK permission gating.
- **Action.** Decision required from user (see "Decision needed" below).
  Then edit `STRATEGY.md` §6 and the `decision-architecture` memory to
  reflect whichever path we choose. Update the `AGENT_SDK_PATTERNS.md`
  guidance section to acknowledge the upstream uses bypass mode and our
  override (if any) is documented.

### Δ2 — Agent SDK version

- **Symptom.** `CLAUDE.md` root + decision memory + `STRATEGY.md` all say
  "pin v0.3.150."
- **Reality.** `container/agent-runner/package.json` line 13:
  `"@anthropic-ai/claude-agent-sdk": "^0.2.128"`. Major version older
  than our spec assumes.
- **Action.** Decide whether to (a) bump to 0.3.x and accept the
  breaking-change cost, or (b) update specs to match the actual upstream
  pin (0.2.128 with the caret-loose range). If staying on 0.2.x:
  re-verify all the AGENT_SDK_PATTERNS guidance against 0.2.x behavior.
  Caret on a 0.x version is implicitly tighter (`^0.2.128` resolves to
  `0.2.x` only); we're not actually floating across major versions.

### Δ3 — `groups/<folder>/CLAUDE.md` is not author-written

- **Symptom.** Commit `cf293f0` wrote a fully-authored persona at
  `groups/career-pilot/CLAUDE.md`. The persona's structure assumes
  that's where the system prompt lives at runtime.
- **Reality.** The composer regenerates this file on every spawn; our
  content is destroyed on first container wake.
- **Action.** Decide on Strategy A / B / C from §4 (Strategy B
  recommended). Then:
  - Strategy B: extend `composeGroupClaudeMd()` to read host-fragments
    from `groups/<folder>/.claude-host-fragments/*.md` and add to
    desired-fragment map. Move the current persona file into
    `groups/career-pilot/.claude-host-fragments/persona.md`. Update
    STRATEGY.md §4 to document this extension and the composer change
    we're making to upstream NanoClaw.
  - Update root `CLAUDE.md` "Where we are" section and `status_current`
    memory to note this rework was needed.

### Δ4 — Output protocol `<message to="name">` is undocumented in our specs

- **Symptom.** Neither PORTAL.md, STRATEGY.md, the persona, nor any
  subagent stub mentions the wrapping requirement.
- **Reality.** `poll-loop.ts:495` parses
  `<message to="…">…</message>` blocks; unwrapped text becomes
  scratchpad and the agent is nudged to re-wrap. `<internal>` blocks
  are scratchpad-marked and stripped from logs.
- **Action.** Add a "Output protocol" section to the persona (the file
  formerly at `groups/career-pilot/CLAUDE.md`, post-Δ3 move). Add a
  short subsection to STRATEGY.md §5 explaining the wrapping protocol.
  Reference `<internal>` as the agent's reflection scratchpad — useful
  for the "Reflection prompting" section of the persona.

### Δ5 — OneCLI is mandatory; `PORTKEY_BYPASS` semantics

- **Symptom.** Specs treat OneCLI as the "non-LLM credential vault" and
  Portkey as the "LLM credential vault." Implicit assumption that
  bypassing Portkey means direct Anthropic call.
- **Reality.** Every container spawn requires OneCLI gateway applied
  (hard throw otherwise). `PORTKEY_BYPASS=true` still routes through
  OneCLI for the actual Anthropic credential. Portkey is a *gateway*
  in front of OneCLI's injected Anthropic key, not an alternative.
- **Action.** Edit STRATEGY.md §V (or wherever Portkey + bypass is
  described) to clarify the layered model: OneCLI → (Portkey gateway
  OR direct) → Anthropic. `PORTKEY_BYPASS=true` toggles only the middle
  layer.

### Δ6 — Persona naming (`persona.local.md`) is not aligned with NanoClaw conventions

- **Symptom.** Persona references `@./persona.local.md` import.
- **Reality.** The composer is the only thing that writes imports into
  the composed `CLAUDE.md`. There's no mechanism for a
  `persona.local.md` to be auto-imported. The intended-by-NanoClaw
  per-group memory file is `CLAUDE.local.md` (fixed name).
- **Action.** Depends on Δ3 strategy choice. If Strategy B: rename to
  `.claude-host-fragments/persona.md`. If Strategy A: append to
  `CLAUDE.local.md` and add a sentinel-section to prevent agent
  auto-memory from clobbering.

### Δ7 — Session lifetime described in STRATEGY.md may not match reality

- **Symptom.** STRATEGY.md likely describes session lifetime in some
  way (need to re-read against actual model).
- **Reality.** Sessions are infinite-lived rows; containers are
  on-demand and frequently re-spawned; conversation context survives
  container restarts via SDK continuation.
- **Action.** Review STRATEGY.md §4 / wherever session model is
  described. Likely small clarifications, possibly the realization that
  some "session-bounded" behaviors we wrote really mean
  "container-bounded" or "conversation-bounded."

### Δ8 — VERIFICATION.md's manual E2E plan needs the output protocol

- **Symptom.** VERIFICATION.md's §1 "voice red-team" tests 10
  scenarios without checking whether the agent's responses are properly
  `<message to="…">`-wrapped.
- **Reality.** An agent that produces good content but no wrapping
  produces *nothing the user sees*. That's a critical bug class.
- **Action.** Add a wrapping-compliance check to VERIFICATION.md §1 +
  §2.

### Δ9 — RECOVERY.md operator commands need building (already known but worth listing)

- **Symptom.** RECOVERY.md describes `/halt`, `/pause`, `/killswitch`
  as if they're configuration knobs.
- **Reality.** None of these exist in NanoClaw. They have to be built
  as MCP tools + corresponding `ncl` subcommands.
- **Action.** No edit to RECOVERY.md (it describes the target behavior
  correctly). Add a Phase 9 task list item: "Build the kill-switch
  primitives as MCP tools + ncl subcommands, backed by the
  `system_modes` table."

### Δ10 — Permission model in PORTAL.md "Audit log" section

- **Symptom.** PORTAL.md likely describes audit-log writes as an
  agent-initiated step.
- **Reality.** Both `dropped_messages` and the destination side of
  routing are host-managed. Agent writes go through MCP tools. The
  `public_audit_trail` (migration 106) is **ours** — only career-pilot
  MCP tools should write it.
- **Action.** Confirm in PORTAL.md that `public_audit_trail` writes go
  through a dedicated MCP tool (`record_public_audit` or similar). Add
  to the Phase 1-2 tool list.

### Decisions made (2026-05-26)

1. **Δ1 — Permission mode:** **Accept NanoClaw's `bypassPermissions`.** Spec deltas applied — `decision_architecture` memory + `AGENT_SDK_PATTERNS.md` §6 + `STRATEGY.md` §4 updated. Security perimeter = container mount geometry + `disallowedTools` bare-name removal + `PreToolUse` hook + approvals module + hard caps.
2. **Δ2 — Agent SDK version:** **Align spec to `^0.2.128` (NanoClaw upstream).** Spec deltas applied — `decision_architecture` memory + `AGENT_SDK_PATTERNS.md` §1 + root `CLAUDE.md` locked-decisions table updated. Phase 5+ revisit.
3. **Δ3 — Persona placement strategy:** **Strategy B — composer extension. IMPLEMENTED.** `src/claude-md-compose.ts` extended to discover `.claude-host-fragments/*.md` and include them in the composed import list. `src/container-runner.ts` mounts the dir RO. Persona content moved to `groups/career-pilot/.claude-host-fragments/persona.md` with the output-protocol section added. `.gitignore` updated for composer-managed `CLAUDE.md` + PII-bearing `candidate.md`. Old `groups/career-pilot/CLAUDE.md` removed (composer owns that path now). First deliberate deviation from upstream NanoClaw — flagged in commit message for future `/update-nanoclaw` runs.

---

## §12 Open questions

Items I couldn't fully determine from source, each tagged with how
to resolve.

| # | Question | Resolution path |
|---|---|---|
| Q1 | What's the host-sweep heartbeat-stale threshold default and where's it tuned? | Read `src/host-sweep.ts` end-to-end. ~15 min. |
| Q2 | When the composer adds a new MCP-tool fragment, does the running container see it immediately or only on next spawn? (Working assumption: next spawn, since CLAUDE.md mount is RO and content is computed once per spawn.) | Read `composeGroupClaudeMd` callers + cross-check with the mount lifecycle; alternatively probe with a runtime experiment in Phase 1. |
| Q3 | How does the agent-to-agent destination "agent" type resolve to a target session? Does it auto-wake the target's container? | Read `src/modules/agent-to-agent/agent-route.ts` (file exists, didn't read this pass). ~20 min. |
| Q4 | What MCP tools does `self-mod.ts` expose, and what's the exact approvals-card flow it uses? We need this pattern for our `record_funnel_event` etc. | Read `container/agent-runner/src/mcp-tools/self-mod.ts` + `src/modules/approvals/`. ~30 min. Will do at Phase 1 implementation time. |
| Q5 | What does the runtime addendum from `buildSystemPromptAddendum` actually look like? Is it just `"You are <name>. Destinations: …"` or something more structured? | Read `container/agent-runner/src/destinations.ts`. ~10 min. |
| Q6 | Where do I configure the model + effort per group? `container.json` per `container_configs.model` / `container_configs.effort`? Confirm. | Read `src/container-config.ts` + `materializeContainerJson()`. ~15 min. |
| Q7 | Does the `chat-sdk-bridge` support the `setTyping` and message-edit primitives we need for the persona's "show typing indicator while agent works" experience? Telegram specifically. | Read `src/channels/chat-sdk-bridge.ts` + experiment via `/add-telegram` skill. |
| Q8 | The `Skill` tool is in the allowlist — agents can invoke skills. What are skills *from the agent's perspective* (vs. from the operator's perspective via `.claude/skills/`)? Are they runnable shell scripts the agent invokes, or something else? | Read one of the simpler skill SKILL.md files + check how the SDK exposes `Skill` as a tool. |
| Q9 | What does `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` do? It's set in the settings.json template but not obviously documented. | Search Claude Code docs + SDK release notes. |
| Q10 | What's the auto-compact behavior? At `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000` tokens — what gets compacted, and how does the PreCompact hook's transcript archive interact with the resulting in-memory state? | Read SDK docs + the `compact-instructions.ts` file referenced in PreCompact hook. |

None of Q1-Q10 block writing the spec deltas (§11) or the immediate
Phase 1 next step. They're the followups that close the last 10% of gaps.

---

## Implementation notes — what to actually do next

In order:

1. **User makes the three decisions** in §11 ("Decisions needed").
2. **Apply spec deltas to PORTAL.md / STRATEGY.md / RECOVERY.md** +
   memories, per the decision-driven Δ-list. Single commit.
3. **Rework the Phase 1 persona placement** per the chosen strategy
   (likely B). If Strategy B: a small upstream-NanoClaw modification to
   the composer + move the persona content to the new location +
   document the deviation in our "vendored upstream changes" log.
4. **Resolve Q4 + Q5** as needed for Phase 1 MCP tool implementation.
5. **Then resume Phase 1**: render the persona host-fragment from
   `candidate_profile` + write the first 6 MCP tools.

End of doc.
