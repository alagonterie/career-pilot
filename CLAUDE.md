# CLAUDE.md — Orientation for Claude Code Sessions

This file tells a Claude Code session opening this repo what it needs to know to be useful immediately. **Read this first.**

---

## Where we are (as of 2026-05-25)

**Branch:** `nanoclaw-rebuild` (off `master`). This branch contains the locked-in v2 architecture specs. Phase 0 (the actual NanoClaw fork landing on disk) has **not yet executed** — the working tree still has the v1 skeleton (an obsolete Next.js frontend stub, an obsolete `backend/src/*.ts` skeleton, etc.). **Don't take cues from the existing code.** It's about to be replaced.

**Status:** Specs are written and reviewed. Next concrete action is Phase 0 from `.specs/STRATEGY.md` §V — fork NanoClaw v2 into this branch, then begin Phase 1 (the career-pilot agent group). See STRATEGY.md §23 for the explicit Phase 0 DELETE/ARCHIVE/ADAPT/KEEP checklist.

**Origin:** branch pushed to `origin/nanoclaw-rebuild`. Commits ahead of master.

---

## The specs are the source of truth

All architecture, UX, and delivery decisions live in `.specs/`. Read in this order:

| File | What it covers | Read when |
|---|---|---|
| `.specs/PORTAL.md` | Frontend UX specification — every page, component, interaction, anonymization model | Always first |
| `.specs/STRATEGY.md` | Backend, infra, delivery plan (10-week phased) | After PORTAL |
| `.specs/AGENT_SDK_PATTERNS.md` | Claude Agent SDK canonical patterns cribsheet | Before any agent-runner code |
| `.specs/CLOUDFLARE_PATTERNS.md` | Cloudflare protection patterns cribsheet | Before any Worker/infra code |
| `.specs/RECOVERY.md` | Operator manual for kill switches + recovery | Keep open during operations |
| `.specs/V2_IDEAS.md` | Deferred features (do NOT scope-creep into these) | When tempted to add scope |

If a question's answer isn't in the specs, ask. If it conflicts with the specs, the specs win unless explicitly redirected.

---

## Locked architectural decisions (do not reopen without explicit go-ahead)

| Decision | Choice | Why locked |
|---|---|---|
| Foundation | Clone-and-customize fork of **NanoClaw v2** (`nanocoai/nanoclaw`) | Not submodule. Not npm-installed. We vendor and customize in place per NanoClaw's own docs. |
| Agent runtime | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, **pin v0.3.150**) | In-process library — NOT Managed Agents (Anthropic-hosted REST product with similar name). See AGENT_SDK_PATTERNS.md §0 for disambiguation. |
| Frontend | **TanStack Start** (RC) on Cloudflare Workers | Type-safe routing, no RSC tax, smaller bundle. NOT Next.js. See decision memory + PORTAL.md §3.5. |
| Styling | Tailwind v4 + shadcn/ui (new-york) + motion/react | Locked in PORTAL.md §3.5 |
| LLM gateway | **Portkey Model Catalog** (Integrations + AI Providers) | "Virtual keys" terminology is deprecated. Use Integrations + AI Providers. PORTKEY_BYPASS=true env enables fallback to direct Anthropic if Portkey is rate-limited or unavailable. |
| Credential vault | **OneCLI** (NanoClaw default) for non-LLM creds (Google OAuth, Telegram, Cloudflare, etc.) | The Anthropic API key lives in Portkey's vault only — container never sees raw keys. |
| Domain pattern | `hire.<DOMAIN>` (Worker) + `api.hire.<DOMAIN>` (Tunnel direct) | Cloudflare research confirms sub-sub-domains work. Worker handles short-lived requests + edge protection; Tunnel direct for SSE streams. |
| VM | GCP **e2-medium**, Ubuntu 24.04 LTS | Not e2-small (OOM under load). Not COS (Ubuntu is easier for NanoClaw+pnpm+OneCLI). |
| Telegram owner channel | v1 only. Discord deferred to V2_IDEAS.md item 3 | |
| Public visitor surface | Web simulator only (no public bot) | V2_IDEAS.md item 1 |
| Agent groups | Two: `career-pilot` (owner) + `career-pilot-sandbox` (public simulator) | |
| Subagents | Five (all read-only): `research-company`, `tailor-resume`, `draft-outreach`, `prep-interview`, `scrape-jobs` | Sandbox group has the first three only; uses `permissionMode: "dontAsk"` + explicit `disallowedTools` bare names |

If you find yourself wanting to change any of these, surface it explicitly to the user first.

---

## Anti-patterns to avoid (we've already debated and rejected these)

- **Docker-per-task agent isolation** — original spec direction; rejected in favor of NanoClaw's per-session containers (one container per session, not per task). See PORTAL/STRATEGY discussion thread.
- **Managed Agents** (Anthropic's hosted REST product) — wrong product for our use case. We use the Agent SDK library.
- **Next.js 15 App Router** — considered, swapped to TanStack Start. Don't suggest Next.js patterns.
- **Portkey Virtual Keys** — deprecated in early 2026. Use Model Catalog (Integrations + AI Providers).
- **`bypassPermissions` mode in Claude Agent SDK** — never use. Use `default` + `canUseTool` callback (owner) or `dontAsk` + explicit `disallowedTools` (sandbox).
- **Throwing from Agent SDK tool handlers** — always `return { isError: true, content: [...] }`.
- **Throwing from hooks** — same; catch internally.
- **`allowedTools` to constrain `bypassPermissions`** — doesn't work. Use `disallowedTools` with bare names.
- **Hardcoded values** — all tunables (intervals, limits, budgets) live in `.env` / `preferences` table / `system_modes` table / `config/defaults.json`. See STRATEGY.md §20.
- **Personal identifiers in active `.specs/` files** — all scrubbed. Use placeholders: `Jane Doe`, `example.com`, `hire.example.com`, `api.hire.example.com`, "the candidate".

---

## CLI tooling preferences

| Task | Use this CLI |
|---|---|
| GitHub anything | `gh` (esp. `gh api repos/...` over WebFetch for GitHub URLs) |
| GCP | `gcloud` |
| Cloudflare Workers | `wrangler` |
| Cloudflare Tunnel | `cloudflared` |
| Cloudflare DNS / WAF | Terraform (`cloudflare.tf`) |
| Terraform | `terraform` |
| NanoClaw admin | `ncl` (NanoClaw's CLI) |
| Credential vault | `onecli` |
| Host package management | `pnpm` |
| Container/agent-runner package management | `bun` (separate dep tree) |
| Ad-hoc DB queries | `pnpm exec tsx scripts/q.ts data/v2.db "..."` (NanoClaw convention) |

See STRATEGY.md §21 for full reference.

---

## Memory system

This project has a persistent memory at `C:\Users\alago\.claude\projects\C--Projects-career-pilot\memory\`. **Check `MEMORY.md` there first** for user role, project goal, locked decisions, current status. The memory persists across conversation compactions.

---

## Workflow rules for working in this repo

1. **Rigor before code.** This project is the candidate's flagship career artifact. Spec-first, then code. When in doubt: confirm direction with the user before writing.
2. **Don't bluff expertise.** If asked to architect on top of a specific framework/library, read its source/docs first. The two research-derived cribsheets (`AGENT_SDK_PATTERNS.md`, `CLOUDFLARE_PATTERNS.md`) are the authoritative deep-dives — refer to them.
3. **Verify summarized research against primary sources.** Subagent research summaries have already been wrong on this project at least once (confused Agent SDK with Managed Agents). When research findings are consequential, fetch the primary docs.
4. **Frontend-first thinking.** The backend exists to feed the portal. Don't add backend complexity that doesn't translate into something compelling on `hire.<DOMAIN>`.
5. **Configuration discipline.** Zero magic numbers. Every tunable goes through `getConfig()` from one of the four tiers (env / preferences / system_modes / defaults.json).
6. **Push back on bad direction grounded in facts.** The user welcomes pushback.

---

## What's next (the actionable to-do list)

1. **Rewrite `README.md`** to match the v2 direction (currently still describes the v1 skeleton). It needs to be generic-by-design — the repo is meant to be forkable.
2. **Phase 0** — execute the fork landing on disk. STRATEGY.md §23 + §V Phase 0. Two commits planned: one for NanoClaw upstream landing, one for our scaffolding additions. Then stop for review.
3. **Phase 1** — career-pilot agent group + migrations 100-107 + first MCP tools.
4. **Phases 2-10** — see STRATEGY.md §V milestone plan (10-week phased delivery to `LIVE_MODE=true`).
