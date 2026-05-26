# STRATEGY.md — Backend, Infrastructure, and Delivery Plan

This is the back-derivation from [PORTAL.md](PORTAL.md). PORTAL.md says *what* the portal must surface; this doc says *how* we build it.

Reading order: PORTAL.md first, then this.

**Companion documents in `.specs/`:**

| Doc | Purpose | When to read |
|---|---|---|
| [PORTAL.md](PORTAL.md) | Frontend UX specification — every page, component, interaction | Before STRATEGY |
| **STRATEGY.md** (this) | Backend, infra, delivery plan | After PORTAL |
| [AGENT_SDK_PATTERNS.md](AGENT_SDK_PATTERNS.md) | Claude Agent SDK canonical patterns cribsheet | Before frontend or agent-runner code lands |
| [CLOUDFLARE_PATTERNS.md](CLOUDFLARE_PATTERNS.md) | Cloudflare protection patterns cribsheet | Before Worker / infra code lands |
| [RECOVERY.md](RECOVERY.md) | Operator manual — what to do when things go sideways | Keep open during operations |
| [V2_IDEAS.md](V2_IDEAS.md) | Deferred features tracked for later | When tempted to add scope |

---

## Part I: Repo & code architecture

### 1. Fork strategy

Career Pilot is a **clone-and-customize fork of NanoClaw v2** (`nanocoai/nanoclaw`). Per NanoClaw's explicit recommendation — and the way every meaningful NanoClaw deployment works — we don't add it as a dependency, we don't submodule it, we *vendor* it as our own working tree and customize in place.

**Concrete plan on the `nanoclaw-rebuild` branch:**

1. Copy NanoClaw v2's full tree (currently `~16 MB`, ~150 source files) into the repo root, replacing the existing skeleton backend/frontend.
2. Preserve our `.specs/` directory and this branch's commit history.
3. Add career-pilot-specific code as **additive modules** at well-known extension points NanoClaw provides — `groups/`, `src/modules/`, `src/channels/`, `src/db/migrations/`, and a new top-level `frontend/`.
4. Run NanoClaw's `bash nanoclaw.sh` setup script once (locally) to install deps, build the container image, and pair Telegram. This is the same setup an end-user-who-forked-NanoClaw would run.
5. Track upstream NanoClaw changes manually via the `/update-nanoclaw` operational skill they ship. We pull useful upstream fixes; we don't push our customizations back (per NanoClaw's "trunk only takes security + bug fixes" policy).

**Why not submodule:** NanoClaw's docs are explicit — submodules conflict with their "customize via code, not config" model. Every skill installer (`/add-telegram`, `/add-discord`, etc.) modifies files in place. A submodule would either be a dead end (can't customize) or a mess (customized submodule + upstream conflicts).

**Why not npm dep:** NanoClaw isn't published. The repo IS the distribution. This is intentional — see [NanoClaw README](https://github.com/nanocoai/nanoclaw#philosophy).

### 2. Repository layout after the fork

```
career-pilot/                         (this repo, public)
├── .specs/                           (our specs — PORTAL.md, STRATEGY.md, etc.)
├── .github/workflows/                (CI/CD; see §15)
├── .husky/                           (pre-commit hooks — pnpm format/lint)
│
├── bin/, scripts/, setup/,           (NanoClaw stock — left alone)
├── launchd/, container/, src/,
├── docs/, config-examples/,
├── repo-tokens/, assets/
│
├── groups/
│   ├── career-pilot/                 ← NEW — owner agent group
│   │   ├── CLAUDE.md                 (composer-generated every spawn, RO-mounted; do NOT hand-edit)
│   │   ├── CLAUDE.local.md           (per-group agent memory, auto-loaded by Claude Code; agent may write)
│   │   ├── .claude-host-fragments/
│   │   │   └── persona.md            (gitignored; host-rendered from candidate_profile before each spawn; composer pulls into the composed CLAUDE.md via our extension — see NANOCLAW_INTERNALS.md §4)
│   │   ├── .claude/agents/           (filesystem subagent definitions)
│   │   │   ├── research-company.md
│   │   │   ├── tailor-resume.md
│   │   │   ├── draft-outreach.md
│   │   │   ├── prep-interview.md
│   │   │   └── scrape-jobs.md
│   │   ├── skills/                   (skill scripts; NanoClaw native)
│   │   │   ├── tailor-resume/
│   │   │   ├── research-company/
│   │   │   ├── draft-outreach/
│   │   │   ├── prep-interview/
│   │   │   └── scrape-jobs/
│   │   └── agent-runner-src/         (overlay for in-process MCP tools)
│   │       └── mcp-tools/
│   │
│   └── career-pilot-sandbox/         ← NEW — public simulator agent group
│       ├── CLAUDE.md                 (sandbox persona)
│       ├── .claude/agents/           (subset: research, tailor, outreach)
│       └── skills/                   (subset: read-only)
│
├── src/                              (NanoClaw host code)
│   ├── modules/
│   │   ├── (NanoClaw stock modules)
│   │   └── portal/                   ← NEW — public API + sanitization
│   │       ├── api.ts                (Express routes)
│   │       ├── sanitizer.ts          (regex + DB + LLM passes)
│   │       ├── public-audit.ts       (taps session DBs → public_audit_trail)
│   │       ├── sse-broadcaster.ts    (live event stream infra)
│   │       ├── system-modes.ts       (LIVE_MODE, pause, halt, killswitch)
│   │       ├── portkey-analytics.ts  (Portkey API proxy + 30s cache)
│   │       ├── simulator.ts          (sandbox session orchestration)
│   │       ├── contact-relay.ts      (POST /api/contact → Telegram)
│   │       └── kill-switch.ts        (the three-tier emergency control plane)
│   │
│   ├── channels/
│   │   ├── (NanoClaw stock + telegram from /add-telegram skill)
│   │   └── portal/                   ← NEW — web simulator as a NanoClaw channel
│   │       ├── adapter.ts            (channel adapter conforming to NanoClaw interface)
│   │       └── sse-output.ts         (outbound delivery via SSE)
│   │
│   └── db/
│       ├── (NanoClaw stock entity files + migrations)
│       └── migrations/
│           ├── 100-applications.ts          ← NEW
│           ├── 101-funnel-events.ts         ← NEW
│           ├── 102-public-audit-trail.ts    ← NEW
│           ├── 103-learnings.ts             ← NEW
│           ├── 104-preferences.ts           ← NEW
│           ├── 105-candidate-profile.ts     ← NEW
│           ├── 106-system-modes.ts          ← NEW
│           └── 107-simulator-runs.ts        ← NEW (for simulator results cache)
│
├── frontend/                         ← NEW — TanStack Start app
│   ├── routes/
│   │   ├── (marketing)/_layout.tsx
│   │   ├── (ops)/_layout.tsx
│   │   ├── index.tsx                 (/)
│   │   ├── live.tsx
│   │   ├── simulator/
│   │   ├── funnel.tsx
│   │   ├── architecture.tsx
│   │   ├── work.tsx
│   │   ├── contact.tsx
│   │   └── about.tsx
│   ├── components/                   (shadcn + custom)
│   ├── lib/                          (sse, api client, etc.)
│   ├── wrangler.toml
│   ├── vite.config.ts
│   └── package.json                  (separate pnpm workspace from host)
│
├── infra/                            (Terraform; keep + adapt)
│   ├── provider.tf
│   ├── main.tf                       (VM: e2-small → e2-medium)
│   ├── cloudflare.tf
│   └── templates/
│       └── user-data.yml.tpl         (cloud-init for the VM)
│
├── package.json                      (root — NanoClaw stock + our additions)
├── pnpm-workspace.yaml               (host + frontend as workspaces)
├── pnpm-lock.yaml
├── nanoclaw.sh                       (NanoClaw stock setup script)
├── tsconfig.json
├── eslint.config.js
├── CLAUDE.md                         (root — orientation for Claude Code)
├── README.md                         (rewritten for career-pilot, generic)
└── SETUP.md                          (rewritten; defers to nanoclaw.sh for most)
```

The principle: **NanoClaw upstream files are left untouched.** Our customizations are additive in well-named locations. Skill installers run cleanly. `/update-nanoclaw` can pull upstream fixes without conflicts.

---

## Part II: Domain model

### 3. Database schema additions

NanoClaw owns the central DB (`data/v2.db`) and per-session DBs. We add career-pilot-specific tables via numbered migrations starting at `100-` to avoid collisions with upstream.

```sql
-- candidate_profile — the owner's persona content (private)
CREATE TABLE candidate_profile (
  id              INTEGER PRIMARY KEY CHECK (id = 1),     -- single row
  full_name       TEXT,
  display_name    TEXT,
  bio             TEXT,                                   -- markdown
  target_roles    TEXT,                                   -- JSON array
  location_pref   TEXT,                                   -- JSON: { remote, hybrid_cities[] }
  comp_floor      INTEGER,                                -- USD/year
  master_resume   TEXT,                                   -- full markdown
  skills          TEXT,                                   -- JSON array, curated
  github_url      TEXT,
  linkedin_url    TEXT,
  x_url           TEXT,
  website_url     TEXT,
  why_this_exists TEXT,                                   -- markdown, for /about
  headshot_path   TEXT,
  brand_color_hsl TEXT,                                   -- override default
  updated_at      TEXT NOT NULL
);

-- applications — the real, private job-application records
CREATE TABLE applications (
  id                  TEXT PRIMARY KEY,
  company_name        TEXT NOT NULL,
  company_aliases     TEXT,                       -- JSON array (for sanitizer lookup)
  obfuscated_label    TEXT NOT NULL,              -- e.g. "fintech-b"; assigned at creation
  public_state        TEXT NOT NULL DEFAULT 'obfuscated',  -- 'obfuscated' | 'partial' | 'public'
  role_title          TEXT NOT NULL,
  job_url             TEXT,
  jd_text             TEXT,
  jd_analyzed         TEXT,                       -- JSON: {level, skills, comp_hint, ...}
  status              TEXT NOT NULL,              -- 'BOOKMARKED' | 'APPLIED' | 'SCREENING'
                                                  -- | 'TECH_SCREEN' | 'SYS_DESIGN' | 'FINAL'
                                                  -- | 'OFFER' | 'REJECTED' | 'WITHDRAWN'
  win_confidence      INTEGER,                    -- 0-100, heuristic
  applied_at          TEXT,
  last_activity_at    TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_public ON applications(public_state);

-- funnel_events — every state transition + agent action against an application
CREATE TABLE funnel_events (
  id                  TEXT PRIMARY KEY,
  application_id      TEXT NOT NULL REFERENCES applications(id),
  kind                TEXT NOT NULL,             -- 'status_change' | 'agent_action'
                                                 -- | 'gmail_signal' | 'calendar_signal'
                                                 -- | 'reflection_added' | 'outreach_drafted'
                                                 -- | 'outreach_sent' | 'interview_scheduled'
  from_status         TEXT,
  to_status           TEXT,
  payload             TEXT NOT NULL,             -- JSON; structure depends on kind
  source              TEXT NOT NULL,             -- 'agent' | 'webhook' | 'owner' | 'sync'
  ts                  TEXT NOT NULL
);
CREATE INDEX idx_funnel_events_app ON funnel_events(application_id, ts DESC);

-- public_audit_trail — sanitized projection consumed by the public API
-- Written by src/modules/portal/public-audit.ts via PostToolUse-style taps
CREATE TABLE public_audit_trail (
  id                  TEXT PRIMARY KEY,
  ts                  TEXT NOT NULL,
  category            TEXT NOT NULL,             -- 'agent_trace' | 'funnel_event'
                                                 -- | 'briefing' | 'system'
  agent_name          TEXT,                      -- subagent name, if applicable
  proactive           INTEGER DEFAULT 0,         -- 0/1 — the ◆ marker
  application_ref     TEXT,                      -- obfuscated_label (never company_name)
  model_used          TEXT,
  tokens              INTEGER,
  cost_cents          INTEGER,
  cache_hit           INTEGER DEFAULT 0,
  latency_ms          INTEGER,
  summary             TEXT NOT NULL,             -- sanitized one-liner
  details_json        TEXT                       -- sanitized, optional
);
CREATE INDEX idx_audit_ts ON public_audit_trail(ts DESC);
CREATE INDEX idx_audit_category ON public_audit_trail(category, ts DESC);

-- learnings — rejection-as-fuel + sibling feedback loops
CREATE TABLE learnings (
  id                  TEXT PRIMARY KEY,
  application_id      TEXT REFERENCES applications(id),
  kind                TEXT NOT NULL,             -- 'rejection' | 'interview-positive'
                                                 -- | 'outreach-win' | 'outreach-loss'
                                                 -- | 'offer-unlock'
  role_category       TEXT,                      -- e.g. 'big-tech-ml', 'series-b-fintech'
  reflections         TEXT NOT NULL,             -- JSON: { what_worked, what_didnt, ... }
  reflection_published INTEGER DEFAULT 0,        -- 0/1 — show on /funnel detail
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_learnings_role_cat ON learnings(role_category);

-- preferences — texture controls (quiet hours, frequency caps, channel prefs)
CREATE TABLE preferences (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL,             -- JSON
  updated_at          TEXT NOT NULL
);
-- seed rows: 'quiet_hours', 'frequency_cap_per_day', 'channel_pref_by_class',
--            'briefing_schedule', 'auto_research_threshold', 'approval_scope'

-- system_modes — LIVE_MODE + pause state
CREATE TABLE system_modes (
  key                 TEXT PRIMARY KEY,          -- 'live_mode' | 'pause_state' | 'pause_reason'
  value               TEXT NOT NULL,             -- JSON
  changed_at          TEXT NOT NULL,
  changed_by          TEXT                       -- user_id who flipped it
);

-- simulator_runs — keeps the last N successful simulator runs for fallback display
-- when the simulator is rate-limited/disabled
CREATE TABLE simulator_runs (
  id                  TEXT PRIMARY KEY,
  ts                  TEXT NOT NULL,
  visitor_company     TEXT,                      -- what they typed; NOT sanitized
  visitor_role        TEXT,
  jd_excerpt          TEXT,                      -- first 500 chars
  tailored_resume     TEXT,                      -- markdown
  outreach_draft      TEXT,                      -- markdown
  total_cost_cents    INTEGER,
  total_latency_ms    INTEGER,
  cache_hit_count     INTEGER,
  shareable           INTEGER DEFAULT 1,         -- 0 if visitor opted out of cache
  expires_at          TEXT                       -- 30 days TTL
);
```

**Schema rules:**
- Use `TEXT` for timestamps (ISO 8601). Consistent with NanoClaw's pattern.
- Use `INTEGER` for booleans (0/1).
- Numbered migration files, append-only. Each migration is `(db: Database) => void`.
- The `obfuscated_label` is assigned at application creation by a deterministic function (`<industry>-<incrementing-letter>`), e.g. `fintech-a`, `fintech-b`, `ai-infra-a`. Industry comes from the JD analysis.

### 4. Agent groups

Two agent groups, with shared skill code but distinct trust boundaries.

#### `groups/career-pilot/` — owner agent group

**Persona file layout** (see [NANOCLAW_INTERNALS.md §4](NANOCLAW_INTERNALS.md) for why this is more complicated than it should be):

- `groups/career-pilot/CLAUDE.md` is **composer-generated on every spawn** by NanoClaw's `composeGroupClaudeMd()`. Hand-edits are destroyed. Contains only `@./` imports.
- `groups/career-pilot/.claude-host-fragments/persona.md` (gitignored) is where we put the authored persona. The composer (extended in Commit 2) reads `.claude-host-fragments/*.md` and includes them in the composed import list. Host writes this file from the `candidate_profile` table before each container spawn.
- `groups/career-pilot/CLAUDE.local.md` is NanoClaw's standard per-group memory file — auto-loaded by Claude Code, writable by the agent. We use it for agent-self-written notes; we do NOT put persona content here (agent auto-memory would clobber sections of it).

The persona content covers:
- The agent's overall mission: "Manage the candidate's job search end-to-end"
- The autonomy gradient (§6.3 of PORTAL.md) codified as concrete dos/don'ts
- The voice: technical, warm, brief, never sycophantic
- The reflection prompting style (for rejection-as-fuel)
- Quiet hours default behavior
- The mandatory `<message to="name">...</message>` output protocol (see [NANOCLAW_INTERNALS.md §6](NANOCLAW_INTERNALS.md))
- Reference to candidate-specific content rendered from `candidate_profile` (gitignored, per-deployment)

**Render-persona hook** — the bridge from `candidate_profile` to the composed system prompt:

The hook is a host-side function called from `container-runner.ts:buildMounts()` *before* `composeGroupClaudeMd()`. It reads the single `candidate_profile` row, renders a markdown file at `groups/<folder>/.claude-host-fragments/candidate.md`, and returns. The composer then picks up that file on its next scan and includes it as an `@./` import in the composed `CLAUDE.md`.

The hook lives at `src/modules/career-pilot/render-persona.ts` (new module; barrel-imported from `src/modules/index.ts` for side-effect registration). It exports `renderPersonaForGroup(group: AgentGroup): void` — pure-ish (filesystem write, no network, no LLM call). Idempotent: same `candidate_profile` row produces byte-identical `candidate.md` output.

**Field-level mapping** (`candidate_profile` columns → markdown sections in `candidate.md`):

| Profile column | Markdown section | Notes |
|---|---|---|
| `full_name` | `# {full_name}` header | First name extracted in-prompt by the agent (via space split); section header is full name. |
| `display_name` | `> {display_name}` blockquote (if differs from full_name) | The candidate's preferred short form, if set. |
| `bio` | `## Background` section, content verbatim | Markdown allowed. |
| `target_roles` (JSON array) | `## Target roles` bullet list | Each array entry → one bullet. |
| `location_pref` (JSON object) | `## Location` section | Render `remote: true/false` + `hybrid_cities[]` bullets. |
| `comp_floor` (integer) | `## Comp` section | Formatted as `$XXX,XXX USD/year floor`. |
| `master_resume` | `## Master resume` section, content verbatim | Markdown allowed; can be long. |
| `skills` (JSON array) | `## Skills` bullet list | Each array entry → one bullet. |
| `github_url`, `linkedin_url`, `x_url`, `website_url` | `## Links` section | Markdown link list; only render fields that are non-null. |
| `why_this_exists` | Excluded | This is for the `/about` portal page, not the agent context. |
| `headshot_path`, `brand_color_hsl`, `updated_at` | Excluded | Portal styling / metadata, not agent-relevant. |

**Failure modes:**

| Condition | Behavior |
|---|---|
| No `candidate_profile` row at all | Write a sentinel `candidate.md` containing just `# Onboarding mode\n\nNo candidate profile yet — walk the candidate through filling it in.`. The persona's onboarding-mode branch then activates. |
| Row exists, all fields null | Same as above (sentinel onboarding content). |
| Row exists, some fields null | Render only the populated sections. Skip null-valued sections silently. |
| JSON-array field contains malformed JSON | Log a warning via `log.warn`; skip just that section (don't crash the spawn). |
| Markdown-unsafe characters in field values (e.g. backticks in `bio`) | Pass through as-is. The agent reads this as authoritative content, not as user input — no escaping needed. |
| Write fails (disk full, permission denied) | Throw. The container spawn will fail downstream when `buildMounts` errors; host-sweep retries from `messages_in`. |

**Trigger point:**

Called from `container-runner.ts:buildMounts()`:

```ts
// In buildMounts, before composeGroupClaudeMd:
if (agentGroup.folder === 'career-pilot' || agentGroup.folder === 'career-pilot-sandbox') {
  renderPersonaForGroup(agentGroup);
}
composeGroupClaudeMd(agentGroup);
```

We gate on folder name so the hook is no-op for any other groups (NanoClaw's `main` group, future skill-installed groups, etc.). The career-pilot-sandbox group also gets the render call so the simulator agent sees the public-facing candidate snippet (a sanitized subset of fields — TBD whether sandbox gets the same `candidate.md` or a stripped version; lock in at Phase 4 sanitization work).

**Definition of done:**

1. With an empty `candidate_profile` table, the hook writes the onboarding sentinel file and the agent's first turn matches the persona's onboarding branch (asks for `full_name` first).
2. With a populated row, the hook produces a markdown file matching the field-mapping table; the composed `CLAUDE.md` imports it; the agent on first turn addresses the candidate by `first(full_name)` and shows awareness of `target_roles` + `comp_floor`.
3. Bumping `candidate_profile.updated_at` (via the `update_profile_field` MCP tool, which lands later in Phase 1) updates `candidate.md` on the *next* container spawn — sessions are spawn-frequent enough that staleness isn't a meaningful problem (per [NANOCLAW_INTERNALS.md §2](NANOCLAW_INTERNALS.md), containers wake on every inbound trigger and freshly compose every time).
4. The render is byte-deterministic: running the hook twice with identical profile state produces identical files (we can diff and the diff is empty).
5. Unit-test coverage: a small Vitest test exercises `renderPersona(profile)` (pure function variant — given a `CandidateProfile` object, returns a string) against three cases: empty row, fully populated row, partial row. The disk-write side runs in the integration test for Commit 2's composer extension.

**Container config (`container_configs` table row):**
- All subagents available
- All in-process MCP tools available, including DB-write and `send_outreach_email`
- `permissionMode`: NanoClaw upstream default (`bypassPermissions`); irreversible actions gated by the approvals module via per-tool hooks rather than SDK-level permission prompts (see [AGENT_SDK_PATTERNS.md §6](AGENT_SDK_PATTERNS.md) for the security-layer model and [NANOCLAW_INTERNALS.md §11 Δ1](NANOCLAW_INTERNALS.md) for the decision rationale)
- A `PreToolUse` hook on `mcp__career-pilot__send_outreach_email` enforces `LIVE_MODE` + enqueues an approvals card (see [AGENT_SDK_PATTERNS.md §5](AGENT_SDK_PATTERNS.md))
- OneCLI scope: full (access to Google OAuth, Telegram, Portkey)
- Model: `@anthropic-prod/claude-opus-4-7` (Portkey Model Catalog AI Provider)
- Session JSONL: written to `/workspace/.claude/` (persistent across container restarts via mount)
- `ENABLE_PROMPT_CACHING_1H=1` env → 1-hour prompt cache TTL for long-running owner sessions

**Wiring (`messaging_group_agents`):**
- Telegram (the candidate) → `career-pilot`, `session_mode='shared'`, owner-only via `user_roles`

#### `groups/career-pilot-sandbox/` — public simulator agent group

**CLAUDE.md (committed, generic):**

A shorter persona for the simulator. Explains:
- "You're running in sandbox mode — a recruiter is testing what this system can do"
- Read-only: no DB writes, no real outreach, no Gmail/Calendar
- Output bounded by a strict token cap to avoid runaway cost
- End cleanly when the run completes

**Container config:**
- Subagents: `research-company`, `tailor-resume`, `draft-outreach` only (no `prep-interview`, no `scrape-jobs`)
- `permissionMode`: NanoClaw upstream default (`bypassPermissions`) — same provider as the owner. Sandbox isolation comes from `disallowedTools` + maxTurns/budget + container mount geometry, not from per-call permission prompts.
- `disallowedTools` (bare names → tools removed from context entirely, so the agent doesn't even know they exist): `["Write", "Edit", "Bash", "mcp__career-pilot__update_application", "mcp__career-pilot__record_funnel_event", "mcp__career-pilot__save_outreach_draft", "mcp__career-pilot__send_outreach_email", "mcp__career-pilot__query_gmail", "mcp__career-pilot__query_calendar"]`
- Effective tool palette (everything not in the disallow list above): `Read`, `WebSearch`, `WebFetch`, `Task`, `mcp__career-pilot__analyze_jd`, `mcp__career-pilot__sanitize_text` — plus whatever NanoClaw built-ins are in the default tool allowlist (the upstream `TOOL_ALLOWLIST` in `providers/claude.ts`)
- OneCLI scope: separate sub-vault `career-pilot-sandbox` containing only a sandbox-specific Portkey API key with a separate spend cap
- Model: `@anthropic-sandbox/claude-opus-4-7` (Portkey AI Provider with separate budget)
- Memory: per-session JSONL only (no cross-session memory)
- `maxTurns: 30` and `maxBudgetUsd: 0.10` (hard caps to prevent runaway)

**Permission-mode note (see [AGENT_SDK_PATTERNS.md §6](AGENT_SDK_PATTERNS.md) for the full security-layer model):** NanoClaw's vendored Claude provider hard-codes `bypassPermissions`. Both agent groups inherit that. Sandbox restriction relies on `disallowedTools` with bare names (which removes the tools from the agent's context entirely — works regardless of permission mode) + maxTurns + maxBudgetUsd. Owner restriction for irreversible actions relies on per-tool `PreToolUse` hooks that enqueue approvals cards. We don't attempt to use `allowedTools` to constrain `bypassPermissions` — that combination doesn't work.

**Wiring:**
- `portal` channel → `career-pilot-sandbox`, `session_mode='per-thread'` — each visitor gets a fresh isolated session

#### Skill code: shared between owner & sandbox

The skill *instructions* (the markdown `SKILL.md` files in `skills/<name>/`) are duplicated between both agent groups via a build-time copy from a shared `groups/_shared-skills/` directory. The container's tool allowlist (set in `container_configs`) determines which MCP tools are available — same skill prompt, different tool palette.

A `scripts/sync-shared-skills.ts` script runs on host startup and after any commit touching `groups/_shared-skills/`. Idempotent.

### 5. Subagent designs

Five subagents, all read-only. Defined as filesystem agents in `.claude/agents/<name>.md`. The Claude Agent SDK loads them automatically when `settingSources` includes `"project"` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set (NanoClaw enables both via `group-init.ts`). SDK pin: `^0.2.128` (NanoClaw upstream) — see [AGENT_SDK_PATTERNS.md §1](AGENT_SDK_PATTERNS.md) for the version caveat and [NANOCLAW_INTERNALS.md §11 Δ2](NANOCLAW_INTERNALS.md) for rationale.

For Agent SDK canonical patterns (hook usage, session persistence, custom tool authoring, cost tracking via `parent_tool_use_id`), see [AGENT_SDK_PATTERNS.md](AGENT_SDK_PATTERNS.md).

Each agent definition file has frontmatter + body:

```markdown
---
description: <when Claude should invoke this subagent>
tools: [<tool names>]
model: <model alias>
maxTurns: <int>
---
<system prompt body>
```

#### `research-company`

```yaml
description: Research a target company's recent news, engineering culture,
  team composition, tech stack, public eng blog highlights, and any
  signals about hiring intent. Invoke when a new application is created
  or a sandbox session targets a new company.
tools: [WebSearch, WebFetch]
model: opus
maxTurns: 12
```

Body: detailed prompt explaining the digest format expected (structured JSON or markdown with stable sections), what to look for, what to *avoid* (no scraping recruiter LinkedIn profiles, no extracting individual employees' email addresses), and the citation requirement (every claim links to a source URL).

Output cached via Portkey semantic cache + a local `research_cache` table (TBD migration) keyed by company domain + date-bucket (weekly).

#### `tailor-resume`

```yaml
description: Given a master resume and a target role + company research,
  produce 5 tailored resume bullet points and a brief rationale for each.
  Read-only — does not modify the master resume.
tools: [Read]   # reads the master resume + persona content composed into the system prompt
model: opus
maxTurns: 8
```

Body: explicit constraints — never fabricate metrics, never invent employment history, prefer concrete numbers from the master resume, lean into terms found in the JD analysis, output diff-friendly (5 bullets with [original → tailored] structure).

#### `draft-outreach`

```yaml
description: Given a target role + company research + recipient hints,
  produce a cold outreach email draft. Tone-match to "technical, warm,
  brief" by default — override-able per run.
tools: [WebSearch, WebFetch]   # for last-minute recipient lookup
model: opus
maxTurns: 8
```

Body: voice rules, length cap (under 200 words), opening rules (no "I hope this email finds you well"), CTA rules (ask for one concrete thing — a call, a referral intro, etc.). Outputs subject + body + recipient suggestion (with reasoning).

#### `prep-interview`

```yaml
description: Given a target company + role + interview type + scheduled
  date, produce an interview prep guide. Read-only research.
tools: [WebSearch, WebFetch, Read]
model: opus
maxTurns: 15
```

Body: prep structure (company-specific signal, recent eng work, likely question themes by interview type, framing rules, things to ask the interviewer). Outputs structured markdown that renders nicely in Telegram + the `/funnel` detail panel.

#### `scrape-jobs`

```yaml
description: Given the candidate's target_roles + location_pref + comp_floor,
  scan public job boards (Greenhouse, Lever, Ashby, LinkedIn open URLs,
  Wellfound) for matching listings posted in the last N days. Returns a
  ranked candidate list with rationale.
tools: [WebSearch, WebFetch]
model: opus
maxTurns: 20
```

Body: scoring rubric (role match, comp signal, company stage match, location match), output format (ranked list with confidence + rationale), explicit guidance to skip noise (recruiter spam, generic FAANG postings the candidate already knows about, expired listings).

### 6. In-process MCP tools

**Scope & non-goals (load-bearing — read this first):** All career-pilot MCP tools operate on the local `data/v2.db` funnel-tracking schema. **No tool in any phase auto-submits job applications** (auto-apply is intentionally never built — V2_IDEAS.md §4). "Adding an application" means inserting a row in our internal `applications` table — like recording an opportunity in a CRM, nothing reaches an external job-board. Public-web reading is limited to SDK built-ins (`WebFetch`, `WebSearch`) used by research subagents in Phase 2+; those have anti-bot mitigations (rate limits, polite UA, fail-open behavior). External-API writes are limited to Gmail (via OneCLI-managed OAuth, official API — no scraping) for outreach, and Google Calendar (same model) for RSVPs. Both are approval-card-gated. Nothing else writes externally.

Defined as a regular MCP server registered in the agent-runner's `nanoclaw` MCP server (`container/agent-runner/src/mcp-tools/`). Career-pilot tools live in `container/agent-runner/src/mcp-tools/career-pilot.ts`; each calls `registerTools([...])` at module scope. Tool naming convention is auto-derived: `mcp__nanoclaw__<tool_name>`.

(Note: STRATEGY.md previously specified `createSdkMcpServer` directly per the 0.3.x Agent SDK pattern. NanoClaw upstream's `^0.2.128` SDK is invoked via `pathToClaudeCodeExecutable` and the MCP server is a child process — see NANOCLAW_INTERNALS.md §8. The `registerTools` self-registration pattern in `mcp-tools/server.ts` is the actual integration point.)

#### 6.1 Container → central-DB contract (the system-action pattern)

The container has NO direct write access to `data/v2.db` (the host's long-lived WAL connection precludes cross-mount writes — see NANOCLAW_INTERNALS.md §3 + §7). The pattern, matching NanoClaw's `cli_request` and `schedule_task` round-trip:

1. **Container MCP tool** writes a `kind: 'system'` row to `outbound.db` via `writeMessageOut()`. Content JSON: `{ action: 'career_pilot.<name>', requestId, payload: {...} }`.
2. **Host delivery sweep** (`src/delivery.ts`) calls the handler registered for that action via `registerDeliveryAction()`. Handler signature `(content, session, inDb)` is the NanoClaw convention — handler accesses central `data/v2.db` via `getDb()`, applies the DB op, and writes a response back to the session's `inbound.db` with `kind: 'system'`, `trigger: 0` (don't wake the agent for this response), and `content: { type: 'career_pilot_response', requestId, frame: { ok, data | error } }`.
3. **Container MCP tool** polls `inbound.db` for the response with matching `requestId` (matches `findQuestionResponse` pattern in `db/messages-in.ts`). Times out at 10s (DB writes are fast; longer timeout hides real bugs).
4. **Tool handler** returns the result to the agent as standard MCP content blocks.

Container reads on `data/v2.db` go through the same pattern (system action → host reads → response back). We do NOT mount v2.db into the container — uniform path keeps the design simple and avoids cross-mount stale-cache edge cases.

All career-pilot action handlers register in `src/modules/career-pilot/index.ts`, barrel-imported from `src/modules/index.ts` for side-effect registration at host startup.

#### 6.2 Tool catalog

**Authoring discipline (per [AGENT_SDK_PATTERNS.md §7](AGENT_SDK_PATTERNS.md)):**
- Tool handlers NEVER throw. Return `{ content: [{ type: "text", text }], isError: true }` on failure — the model sees the error as data and can adapt.
- Use `structuredContent: {...}` for typed data the model should reason about; reserve the `content[].text` field for natural-language summaries.
- Include `annotations: { readOnlyHint: true }` on read-only tools so the SDK can parallelize them.
- Detailed `description` strings drive selection quality — invest 3-4 sentences per tool.

| Tool | Args | Side effect | Phase | Owner | Sandbox |
|---|---|---|---|---|---|
| `update_profile_field` | `{ field: string, value: any }` | UPSERT into `candidate_profile` (single-row table) | 1 | ✓ | ✗ |
| `update_application` | `{ id: string, patch: object }` | UPSERT into `applications`. INSERT branch requires `patch.company_name + role_title + status`; host assigns `obfuscated_label` deterministically | 1 | ✓ | ✗ |
| `record_funnel_event` | `{ application_id: string, kind: string, payload: object }` | INSERT into `funnel_events`; sanitization mirror to `public_audit_trail` lands in Phase 3 | 1 | ✓ | ✗ |
| `get_application` | `{ id: string }` | SELECT one from `applications` | 1 | ✓ | ✗ |
| `list_applications` | `{ status?: string, limit?: number }` | SELECT from `applications` (filtered) | 1 | ✓ | ✗ |
| `analyze_jd` | `{ text_or_url: string }` | LLM call (Haiku via OneCLI gateway) → `{level, skills, comp_hint, role_category}`. Deferred from Phase 1 because in-container Haiku call needs the subagent infra | 2 | ✓ | ✓ |
| `sanitize_text` | `{ raw: string, application_id?: string }` | none (regex + `company_aliases` DB lookup). Deferred because the alias lookup is only useful once multiple applications exist + Phase 3's sanitizer pipeline is its real home | 3 | ✓ | ✓ (no application_id) |
| `parse_email` | `{ raw: string }` | none (Haiku via OneCLI) | 2 | ✓ | ✗ |
| `save_outreach_draft` | `{ application_id: string, draft: object }` | INSERT into `funnel_events` (kind `outreach_drafted`) | 2 | ✓ | ✗ |
| `send_outreach_email` | `{ application_id: string, draft: object }` | **EXTERNAL**: sends via Gmail; gated by LIVE_MODE + approval card | ✓ | ✗ |
| `schedule_followup` | `{ application_id: string, when: ISO8601, prompt: string }` | NanoClaw native `schedule_task` invocation | ✓ | ✗ |
| `get_application` | `{ id: string }` | none | ✓ | ✗ |
| `list_applications` | `{ filter?: object }` | none | ✓ | ✗ |
| `query_gmail` | `{ query: string, since?: ISO8601 }` | none (proxied via OneCLI) | ✓ | ✗ |
| `query_calendar` | `{ range: { start, end } }` | none (proxied via OneCLI) | ✓ | ✗ |
| `add_learning` | `{ application_id?: string, kind: string, reflections: object }` | DB write `learnings` | ✓ | ✗ |
| `update_profile_field` | `{ field: string, value: any }` | DB write `candidate_profile` | ✓ | ✗ |

Each tool is a single TS file in `mcp-tools/`. The barrel `mcp-tools/index.ts` exports `careerPilotMcpServer` (the `createSdkMcpServer` result). Tool visibility per agent group is controlled by the `allowedTools` / `disallowedTools` settings in `container_configs` (see §4) — NOT by the barrel.

---

## Part III: Integration surfaces

### 7. Channel adapters

#### Telegram

Installed via NanoClaw's `/add-telegram` skill, which clones the adapter from the `channels` branch of `nanocoai/nanoclaw` into `src/channels/telegram/`. Configuration:

- Bot token in OneCLI vault (key: `telegram_bot_token`)
- `ALLOWED_TELEGRAM_CHAT_ID` env var = the candidate's chat ID (drops messages from any other ID)
- Wired to `career-pilot` agent group, `session_mode='shared'`

#### `portal` channel (custom)

A new channel adapter we write — not from NanoClaw upstream. Conforms to NanoClaw's channel interface but transport is HTTP + SSE instead of bot polling.

**Inbound:** `POST /api/simulator` from the frontend hits `src/modules/portal/api.ts`, which calls into the portal channel adapter's `submit()` — creating a NanoClaw session (per-thread) and writing the initial `messages_in` row of `kind='chat'`.

**Outbound:** the channel adapter holds a registry of active SSE connections keyed by `session_id`. When `delivery.ts` calls the adapter's `sendMessage()`, it pushes a formatted event into the matching SSE stream.

Session lifecycle:
- 30-second idle timeout on the sandbox container
- 5-minute hard wall on total session duration (safety)
- Session torn down after final `messages_out` of `kind='task'` (the orchestrator emits this when wrapping up)

### 8. External integrations: Gmail & Calendar

#### Gmail

- OneCLI vault holds the Google OAuth refresh token (key: `google_oauth_refresh_token`)
- Owner authorizes via a one-time `GET /api/google/auth-url` → consent → `GET /api/google/callback` flow on the host (existing partial implementation in the current `backend/src/google.ts` is a useful starting point — port the OAuth wiring)
- A scheduled host task (every 60s) calls `query_gmail` for new messages matching: `newer_than:1d (interview OR "schedule your call" OR "application received" OR "moving forward" OR "next steps" OR "unfortunately")`
- Matched messages are passed through `parse_email` → if classified as a recruiter signal, a `messages_in` row of `kind='webhook'` is written to the owner's session with the parsed payload
- Container wakes, agent decides what to do (update funnel, draft reply, ping owner)

#### Calendar

- Same OAuth scope, same vault entry
- Scheduled host task polls upcoming events with title matching `(interview|onsite|screen|chat|sync)` from companies in `applications`
- Detected events → `messages_in` of `kind='webhook'` with `event_type='interview_scheduled'`
- Agent updates funnel state → schedules a 24h-before `prep-interview` task

### 9. Sanitization pipeline

Three-pass, host-side. Lives in `src/modules/portal/sanitizer.ts`.

```typescript
export async function sanitize(raw: string, opts?: { application_id?: string }): Promise<string | null> {
  // Pass 1: deterministic regex
  let text = applyRegexPasses(raw);  // emails, phones, SSN-like, monetary, addresses, URLs with PII

  // Pass 2: company name + alias replacement
  const apps = await db.all(`
    SELECT id, company_name, company_aliases, obfuscated_label, public_state
    FROM applications
    WHERE public_state != 'public'
  `);
  for (const app of apps) {
    const names = [app.company_name, ...JSON.parse(app.company_aliases ?? '[]')];
    for (const name of names) {
      const escaped = escapeRegex(name);
      text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), `[REDACTED:${app.obfuscated_label}]`);
    }
  }

  // Pass 3 (optional): Haiku context-sensitivity review
  if (text.length > MIN_LLM_PASS_THRESHOLD || opts?.application_id) {
    const review = await haikuReviewForLeak(text);
    if (review.flagged && review.risk_level === 'high') {
      // Escalate to owner; do NOT publish
      await notifyOwnerOfSanitizationFlag(review);
      return null;
    }
  }

  return text;
}
```

**`record_funnel_event` and `update_application` write hooks** automatically sanitize their payloads and mirror to `public_audit_trail`. If sanitization returns `null` (Pass 3 flagged), the public mirror is skipped but the private write still happens — the system preserves the truth privately while withholding from the public.

### 10. Public API layer

Express app, lives in `src/modules/portal/api.ts`. Started by the NanoClaw host on a configurable port (default `3001`, behind Cloudflare Tunnel).

**Domain split (verified via Cloudflare research, see [CLOUDFLARE_PATTERNS.md §1](CLOUDFLARE_PATTERNS.md)):**

| Hostname | Served by | Routes |
|---|---|---|
| `hire.example.com` | Cloudflare Worker (TanStack Start) | All marketing/ops pages, `POST /api/contact`, `POST /api/sandbox/*` (Turnstile-protected) |
| `api.hire.example.com` | Cloudflare Tunnel → Express | `GET /api/funnel`, `GET /api/activity`, `GET /api/activity/stream` (SSE), `GET /api/telemetry`, `GET /api/architecture`, `GET /api/simulator/:id/stream` (SSE), `GET /api/simulator/results/:id`, `GET /api/system-status` |

**Why the split:** Worker absorbs short-lived requests and applies edge protection (Turnstile, WAF, rate limits via Workers RL + Durable Objects). SSE streams go direct to `api.hire.*` for efficiency — no Worker subrequest quota burn, lower latency. Cloudflare Workers DO support SSE (no fixed duration, only CPU time is metered, and `fetch()` waits don't count) — we use the direct path as an optimization, not a workaround.

```
Worker routes (hire.example.com):
  POST /api/contact           ← Turnstile-protected; relays to owner Telegram
  POST /api/sandbox/start     ← Turnstile + WAF + DO daily caps; spawns sandbox session

Tunnel routes (api.hire.example.com):
  GET  /api/funnel            ← sanitized public_funnel_view
  GET  /api/activity          ← sanitized public_audit_trail (last 50)
  GET  /api/activity/stream   ← SSE: live sanitized events
  GET  /api/telemetry         ← Portkey + local aggregates (cached 30s)
  GET  /api/architecture      ← NanoClaw central DB + Docker status
  GET  /api/simulator/:id/stream   ← SSE: sandbox session output
  GET  /api/simulator/results/:id  ← 30d-TTL cached run output
  GET  /api/system-status     ← LIVE_MODE / pause / health
```

**CORS:** explicit allow-list (`hire.example.com` + dev origins). No `*`.

**Origin protection (triple defense, see [CLOUDFLARE_PATTERNS.md §5](CLOUDFLARE_PATTERNS.md)):**
1. **Cloudflare Access Service Auth** (free for ≤50 users) in front of the Tunnel. Worker sends `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers (Worker secrets).
2. **JWT validation at origin** of the `Cf-Access-Jwt-Assertion` header using `jose` against the team's JWKS endpoint.
3. **Authenticated Origin Pulls (mTLS)** at the zone level — defense in depth so leaked tunnel hostname is useless without the Cloudflare client cert.

### 11. System modes implementation

Spread across three files but coordinated:

- `src/modules/portal/system-modes.ts` — reads/writes `system_modes` table, exports `getLiveMode()`, `setPauseState()`, etc.
- `src/command-gate.ts` (NanoClaw native, extended) — handles `/pause`, `/resume`, `/halt`, `/killswitch` Telegram commands; routes them to system-modes setters
- `src/container-runner.ts` (NanoClaw native, extended via a host hook) — checks `getPauseState() === 'active'` before spawning containers; returns "system paused" if halted

External-action tools (`send_outreach_email`, `respond_to_calendar_invite`) wrap their bodies in:

```typescript
const mode = await getLiveMode();
if (!mode.live) {
  return { content: [{ type: 'text', text: 'DRY_RUN: action skipped, draft saved.' }] };
}
const approval = await requestApprovalCard({ action: ..., recipient: ... });
if (!approval.granted) {
  return { content: [{ type: 'text', text: 'Owner declined approval.' }] };
}
// proceed with real send
```

The `/killswitch` handler does five things in sequence:
1. `setPauseState('killswitch', reason)`
2. `MAX_CONCURRENT_CONTAINERS = 0` env override + kill running containers
3. `oneCliClient.revokeAgent(...)` for all agent IDs
4. `portkeyClient.setBudget(0)` (admin API)
5. Update `system_modes` table → portal worker reads this and serves the static "paused for review" page

Recovery from killswitch is intentionally manual — `/resume` doesn't work. Owner must SSH, run `scripts/recover-from-killswitch.sh` which re-issues OneCLI tokens, resets Portkey budget, clears the killswitch flag, and brings the system back online in shadow mode (`LIVE_MODE=false`). Detailed step-by-step in [RECOVERY.md §3](RECOVERY.md).

**Full operator manual for all pause/halt/recovery scenarios:** [RECOVERY.md](RECOVERY.md). Designed reassurance — the candidate should feel safe with the kill switches because every one has a documented recovery path.

---

## Part IV: Infrastructure & ops

### 12. Credentials & secrets

| Secret | Stored in | Used by | In repo? |
|---|---|---|---|
| Anthropic API key | Portkey Integration | Portkey, when proxying Claude calls | No |
| Portkey API key | OneCLI vault | Container, for `Authorization` header to `api.portkey.ai` | No |
| Google OAuth client ID + secret | `.env` (host) | OAuth handshake | No |
| Google OAuth refresh token | OneCLI vault | Container, for Gmail/Calendar API calls | No |
| Telegram bot token | OneCLI vault | Telegram channel adapter | No |
| Cloudflare API token | `.env` (host) + GitHub secret | Terraform + CI/CD only | No |
| Cloudflare Tunnel token | `.env` (host) | `cloudflared` container | No |
| Allowed Telegram chat ID | `.env` | Telegram adapter (whitelist) | No |
| Portal Turnstile site key | `.env` (frontend, public) | Frontend `/contact` form | No (env injection) |
| Portal Turnstile secret | `.env` (host) | `/api/contact` validation | No |

Container env on session start contains only OneCLI connection vars + the Portkey base URL + `ENABLE_PROMPT_CACHING_1H=1`. Everything else is injected at request time by OneCLI.

**Portkey terminology note:** We use Portkey's **Model Catalog** (Integrations + AI Providers — see [STRATEGY § Setup notes](#)) which replaced the deprecated Virtual Keys concept in early 2026. An "AI Provider" is the workspace-scoped slug (e.g. `@anthropic-prod`) that maps to a vaulted Integration holding the actual Anthropic API key. Reference: [Portkey upgrade guide](https://portkey.ai/docs/support/upgrade-to-model-catalog).

**Portkey bypass fallback (for when Portkey is down, rate-limited, or budget-exhausted):**

```bash
# In .env on the VM
PORTKEY_BYPASS=true
ANTHROPIC_API_KEY=sk-ant-...    # raw Anthropic key, vaulted in OneCLI
```

The credential layering is **OneCLI → (Portkey gateway OR direct) → Anthropic**. `PORTKEY_BYPASS=true` toggles only the middle layer — OneCLI is unconditional (NanoClaw's `container-runner.ts` throws and refuses to spawn the container if the OneCLI gateway isn't applied; see [NANOCLAW_INTERNALS.md §9](NANOCLAW_INTERNALS.md)).

When `PORTKEY_BYPASS=true`:
- Containers spawn with `ANTHROPIC_BASE_URL` set to the default Anthropic endpoint
- OneCLI injects the raw `ANTHROPIC_API_KEY` per-request (same flow as Portkey-mode, different upstream)
- Portkey-derived telemetry on `/live` shows `—` instead of cache rate / spend
- Cost tracking falls back to the SDK's `total_cost_usd` estimate (less authoritative)

To restore: remove `PORTKEY_BYPASS`, restart `career-pilot.service`. See [RECOVERY.md §8](RECOVERY.md).

### 13. Infrastructure (GCP + Cloudflare)

**VM:** GCP Compute Engine `e2-medium` (2 vCPU, 4 GB RAM) — ~$26/mo on-demand or ~$13/mo with sustained-use discount. Region per `gcp_region` Terraform variable (default `us-central1`). Ubuntu 24.04 LTS image (not COS — we need apt for Docker + pnpm install ergonomics).

**Host install (via cloud-init `user-data.yml.tpl`):**
1. `apt update && apt install -y docker.io docker-compose-plugin nodejs npm curl`
2. `npm install -g pnpm@10`
3. `useradd career-pilot && usermod -aG docker career-pilot`
4. Pull this repo to `/opt/career-pilot/`
5. Run `bash nanoclaw.sh --headless` (a flag we'll add to NanoClaw's setup for non-interactive bootstrap)
6. Install OneCLI via NanoClaw's `/init-onecli` skill
7. Register systemd service `career-pilot.service` (NanoClaw provides this)
8. Run cloudflared as a sibling container; tunnel token comes from Terraform output → injected env

**Why e2-medium not e2-small:** NanoClaw spawns one container per active session (Bun, ~200-400 MB). With the candidate's owner session + up to 3 simultaneous sandbox sessions + the host node process + cloudflared, we need ~2-3 GB working set. e2-small (2GB) would OOM under any load. e2-medium has headroom.

**Cloudflare:** (full patterns reference in [CLOUDFLARE_PATTERNS.md](CLOUDFLARE_PATTERNS.md))

| Surface | Service | Config |
|---|---|---|
| `hire.example.com` | Cloudflare Worker (TanStack Start build via `wrangler deploy`) | Static assets, SSR pages, Turnstile-protected POST endpoints, Durable Object daily caps for sandbox |
| `api.hire.example.com` | Cloudflare Tunnel → `cloudflared` container on VM | Triple defense: CF Access Service Auth + JWT validation at origin + Authenticated Origin Pulls (mTLS) |
| DNS for both | Cloudflare DNS (managed via Terraform `cloudflare.tf`) | CNAMEs |
| Analytics | Cloudflare Web Analytics (free, no cookies) | JS beacon in TanStack Start root layout |
| Spam protection | Cloudflare Turnstile (free, 20 widgets) | `/contact` and `/api/sandbox/start` with server-side `siteverify` + `idempotency_key` |
| Rate limiting | Workers Rate Limiting binding (free) + Durable Objects | 60s burst (Workers RL) + 10/IP/day + $5/day global cap (DOs with midnight `alarm()`) |
| WAF | Cloudflare Free Managed Ruleset (on by default) + 1 custom rule + 1 rate-limit rule | Custom rule on `/api/sandbox/*` missing Turnstile cookie |
| Bot Fight Mode | ON at `hire.*` (apex), OFF at `api.hire.*` (would break Worker→backend signed headers) | |

VM has no public HTTP ports open. SSH (`tcp/22`) is the only public port, locked down via Identity-Aware Proxy (IAP) ranges in `iac/main.tf`.

### 14. Frontend stack (refers to PORTAL.md §3.5)

See PORTAL.md §3.5 for the locked frontend stack (TanStack Start RC + Cloudflare Workers + Tailwind v4 + shadcn). Repeating the discipline rule here for emphasis:

**Before any frontend code lands:** do a focused TanStack Start docs read. Specifically:
- Latest RC release notes (API churn risk)
- Cloudflare Workers adapter docs (deploy pipeline + `wrangler.toml` shape)
- Server functions API (typed RPC pattern)
- Route loaders + `useSearch()` (typed search params)
- SSE-from-loader patterns (or fetch-stream-reader from client)
- Tailwind v4 `@theme` directive integration

This is a milestone (see §17), not a "do it later" — it's the gate to writing the frontend.

### 15. CI/CD

Two GitHub Actions workflows, replacing the existing scaffolding:

**`.github/workflows/deploy-frontend.yml`:**
- Trigger: push to `master`, paths `frontend/**`
- Steps: pnpm install in `frontend/`, build via `pnpm build` (Vite + TanStack Start adapter), `wrangler deploy` with secrets from GitHub
- Env injection: `NEXT_PUBLIC_*` style for build-time variables (candidate name, social URLs — but only the URLs, NOT the bio/resume which stay private)

**`.github/workflows/deploy-backend.yml`:**
- Trigger: push to `master`, paths `src/**`, `groups/**`, `package.json`, etc.
- Auth: Google Workload Identity Federation (no long-lived JSON keys)
- Steps: `gcloud compute scp` the repo to VM (or `git pull` on the VM via SSH), run `pnpm install --frozen-lockfile`, restart `career-pilot.service`
- Container rebuild: only if `container/` files changed (use a path filter)

**`.github/workflows/test.yml`:**
- Trigger: every push
- Steps: `pnpm test` (Vitest on host, `bun test` on container — separate jobs)
- Linting: ESLint + Prettier check
- Type check: `tsc --noEmit` on host and container trees

### 16. Local development

**Core goal:** developer can iterate narrowly (single skill / single subagent / single component) or broadly (full E2E: Telegram → agent → DB → portal SSE → frontend live update) without manual fiddling, on Docker Desktop, with confidence and speed. the candidate works from two machines — the setup story must be idempotent and friction-free on both.

#### 16.1 Local stack

- NanoClaw host runs natively (`pnpm dev`) — faster iteration than dockerized
- Ollama runs in a Docker container (GPU passthrough enabled if available)
- Agent containers run via local Docker daemon
- TanStack Start dev server runs natively (`pnpm dev` in `frontend/`)
- A separate dev Telegram bot token (so dev doesn't fight prod)
- A separate dev SQLite DB at `data/v2.dev.db`
- A separate OneCLI dev vault namespace (`career-pilot-dev`)

#### 16.2 LLM provider switching — three modes

| Mode | `LLM_PROVIDER` env | What runs | Cost | Use case |
|---|---|---|---|---|
| **`ollama`** (default for `pnpm dev`) | `ollama` | Local Llama 3.2 via NanoClaw's `/add-ollama-provider` | $0 | Plumbing tests — does the flow work end-to-end? |
| **`claude_test`** | `claude_test` | Real Claude via Portkey, but with strict per-day cap (e.g., $2/day) and a separate Portkey AI Provider with its own budget | <$2/day | Quality testing — does the simulator actually produce good output for a recruiter? |
| **`claude_prod`** | `claude_prod` | Real Claude via Portkey production AI Provider | Real | Production VM only — never set locally without explicit override |

Switching is just an env var change + restart. The host wires the right Portkey AI Provider slug based on `LLM_PROVIDER`:

```typescript
// src/llm-routing.ts
const AI_PROVIDERS = {
  ollama: "@ollama-local/llama3.2",
  claude_test: "@anthropic-test/claude-opus-4-7",     // separate Portkey AI Provider, $2/day cap
  claude_prod: "@anthropic-prod/claude-opus-4-7",     // production cap
};
```

For **narrow quality testing** (e.g., "does the resume tailor produce decent output for this specific JD?"), there's a `pnpm test:quality` script that wraps the agent invocation, prompts you to confirm before each LLM call, prints the cost, and skips persisting anything to the dev DB. Costs ~$0.04 per test run.

#### 16.3 Setup script (`scripts/setup-local.ts`)

**Must be:** idempotent, interactive when needed, fast on re-runs, friction-free. Works on Windows (WSL2 required), macOS, and Linux.

```
pnpm setup
```

What it does (each step is idempotent and skip-if-done):

1. **Detect environment.** Refuses to run if `ENVIRONMENT=production` or if hostname matches the prod VM (safety guard).
2. **Check prerequisites.** Node 20+, pnpm 10+, Docker, gh CLI authenticated, wrangler authenticated. For missing tools, prints the exact install command for the OS and exits non-zero.
3. **Install deps.** `pnpm install` at root (host) + `cd frontend && pnpm install` (workspace).
4. **Initialize OneCLI dev vault.** Sets up the `career-pilot-dev` namespace; prompts for any missing secrets (Portkey API key, Anthropic key for fallback, Telegram dev bot token).
5. **Start Ollama container.** Detects existing `ollama` container; reuses or creates. Pulls `llama3.2` model if not present (idempotent).
6. **Run NanoClaw setup.** Interactive Telegram pairing for the dev bot (skipped if already paired).
7. **Apply migrations.** On `data/v2.dev.db`.
8. **Build agent container image.** Skipped if image exists and `container/` hasn't changed.
9. **Seed defaults.** Inserts default rows into `preferences` and `system_modes` if not present.
10. **Print next steps:** `pnpm dev` (host) + `cd frontend && pnpm dev` (portal).

Re-run any time — safe.

#### 16.4 Narrow vs broad testing

| Scope | How |
|---|---|
| One MCP tool | `pnpm test:tool update_application` (unit test against the dev DB) |
| One subagent prompt | `pnpm test:subagent tailor-resume --jd-file=fixtures/jd-example.md` (runs the subagent in isolation, returns output; uses `LLM_PROVIDER` whichever you've set) |
| Sanitization pipeline | `pnpm test:sanitize` (regex + DB lookup + LLM review pass on a fixture set) |
| Portal API | `pnpm test:api` (Vitest against Express, mocks the agent subsystem) |
| Frontend component | `pnpm --filter frontend test` (Vitest + Testing Library) |
| Frontend visual | `pnpm --filter frontend dev` + browse manually |
| Full E2E plumbing | Send a message to the dev Telegram bot — see what happens. Uses Ollama, $0. |
| Full E2E with real LLM | `LLM_PROVIDER=claude_test pnpm dev` — uses Claude with the $2/day cap |

#### 16.5 Reset to clean state (`pnpm reset:dev`)

Critical for testing onboarding/bootstrap flows. Safety-guarded against running in prod.

```
pnpm reset:dev
```

What it does (interactive — confirms each step):
1. Kills all running career-pilot agent containers
2. Stops the local host process
3. Wipes `data/v2.dev.db` and all session JSONLs in dev
4. Clears OneCLI `career-pilot-dev` vault entries (NOT production — different namespace)
5. **Preserves:** dev Telegram bot pairing (per-account), `.env`, installed deps, container image
6. Re-applies migrations
7. Prints "Ready — send `/start` to your dev bot to re-bootstrap"

Recovery time: ~30 seconds. Full onboarding cycle: ~5 minutes via Telegram.

Detailed procedure in [RECOVERY.md §7](RECOVERY.md).

#### 16.6 Hot-reload preference / config changes

The host watches `data/v2.dev.db` `preferences` and `system_modes` tables (via SQLite's file-modification time or a simple poll). When a row changes, it writes a `messages_in` row of `kind: 'system'` with `action: 'reload_preferences'` to all active sessions. Containers invalidate their cached preferences on receipt.

This means changes to quiet hours, budgets, frequency caps, etc. take effect within ~5 seconds, no restart required. Same mechanism applies in production.

#### 16.7 Configuration discipline

**No magic numbers in code.** Every tunable lives in one of:

- `.env` — deployment-environment-specific (keys, hostnames, ports, OneCLI connection info)
- `preferences` table — owner-tunable (quiet hours, budgets, frequency caps, channel preferences by message class, briefing schedule)
- `system_modes` table — operational state (live mode, pause state, killswitch state)
- `config/defaults.json` (committed) — initial seeds for `preferences` and `system_modes`, single source of truth for defaults

The setup script (§16.3) seeds defaults from `config/defaults.json`. The host has a runtime helper `getConfig(key, fallback?)` that reads from the right tier in precedence: env > preferences > defaults.json.

Examples of what MUST be configurable (not hardcoded):
- Poll intervals (`HOST_SWEEP_INTERVAL_SEC` default 60, `ACTIVE_POLL_INTERVAL_SEC` default 1)
- Rate limits (sandbox runs per IP per day default 10, global $ cap default $5)
- LLM budgets (owner daily default $5, sandbox daily default $5)
- Container resource limits (memory default 512MB, CPU default 1.0)
- Session idle timeout (default 30 min)
- Cache TTL strategy (5min/1hour toggle)
- Sanitization aggressiveness (regex strictness, LLM review threshold)
- Webhook polling frequency (Gmail default 60s, Calendar default 5min)
- All the texture controls from PORTAL.md §6.4

See §20 for the full configuration model.

### 17. Observability

Two surfaces of observability: **public** (sanitized, recruiter-facing on the portal) and **owner-private** (full-fidelity, the candidate only).

#### 17.1 Public surface — `/live` portal panels

| Signal | Source | Surfaced where |
|---|---|---|
| LLM cost / cache rate / token usage | Portkey Analytics API (or SDK fallback if `PORTKEY_BYPASS`) | `/api/telemetry` → `/live` panel |
| Active sessions / containers (counts) | NanoClaw central DB + Docker | `/api/architecture` → `/architecture` page |
| Agent trace events (sanitized) | `public_audit_trail` | `/api/activity` + SSE → `/live` stream |
| Host health (color-coded) | systemd + `journalctl` aggregate | `/api/system-status` |
| Simulator runs (success/failure rate, aggregate) | `simulator_runs` table | `/api/telemetry` |

#### 17.2 Owner-private surface — Telegram + `/admin`

The owner needs more than the public portal shows. Two channels:

**Telegram (`/status`, `/cost`, `/sessions`, `/inspect`):**
- `/status` — daily briefing snapshot on demand: budget burn today, active applications by stage, today's events
- `/cost` — full breakdown: today's spend by subagent, by model, by application; "burn at this rate would deplete N days of remaining budget"
- `/sessions` — list of active NanoClaw sessions with ages, last activity
- `/inspect <application-id>` — full timeline + last 20 sanitized events + private notes (real company name, recruiter name, etc.)
- `/inspect <session-id>` — recent agent decisions and tool calls (full fidelity, owner-only)

**`/admin` portal page (gated by a signed cookie token, refreshed via Telegram on demand):**

A dense ops dashboard, owner-only, that surfaces:
- **Cost dashboard:** today's spend, this week, this month; by application, by subagent, by model; cache hit rate trends; budget runway projection (at current burn, X days until daily cap → flip dry-run mode)
- **Agent trace stream (UNSANITIZED):** the real version of the public `/live` stream — real company names, recruiter info, full payload
- **Pending approvals queue:** all `ask_user_question` cards still waiting on the candidate's response, with deep-link to Telegram thread
- **Sanitization spot-check:** side-by-side raw vs sanitized for a sliding window of recent events. Owner can flag any false negatives (real PII that leaked through), which adds a regex pattern automatically
- **Pause/halt/killswitch state + history:** every mode change with timestamp and reason
- **Quick admin actions:** `/setmode shadow|live`, `/halt`, edit `preferences`, force a `research-company` re-run, etc. — all via signed POST to the host's admin endpoints

**Auth pattern:** `/admin` validates a signed cookie. The cookie is issued only via Telegram (`/admin login` → bot replies with a short-lived link). Multi-day session, refreshed automatically while you have an active Telegram presence.

#### 17.3 Telegram alert channel (separate from owner chat)

A separate Telegram chat with a different bot, dedicated to alerts (so owner chat stays clean). Receives:
- Host process crash/restart
- Sanitization Pass 3 flagged content (requires owner review)
- `LIVE_MODE` state change
- Daily spend at 80% of cap (warn), 100% (hard stop)
- Killswitch triggered
- Cloudflare Tunnel disconnect
- VM disk usage > 80%
- Backup failure
- TLS cert renewal failure

Owner can `/mute alerts` for a window; critical alerts (killswitch, breach indicators) bypass mute.

#### 17.4 Cost transparency for visitors (public framing)

On `/about`:
> *"This system has cost the candidate $X.XX so far in their job search. The cache saves about Y% — without it, this would have cost $Z.ZZ. When [outcome] happens, it'll be worth every cent."*

Numbers updated live from the same telemetry as `/live`. The transparency is itself a credibility move.

### 18. Cost model

Realistic monthly estimate. We accept ~$65-100/mo as a price worth paying for a serious job search — that's been explicitly weighed against the alternative of stripping features to save money. Cost transparency is also a portal feature (see §17.4), not a thing to hide.

| Item | Estimate |
|---|---|
| GCP e2-medium (us-central1, sustained use) | $13 |
| GCP egress (minimal, mostly via Cloudflare Tunnel) | $1-3 |
| Cloudflare Workers (free tier covers 100k req/day) | $0 |
| Cloudflare Tunnel + DNS + Access (≤50 users) | $0 |
| Cloudflare Web Analytics + Turnstile | $0 |
| Domain renewal (example.com) | $1/mo amortized |
| Anthropic API via Portkey (the candidate's actual usage, with 1h caching) | $30-80 |
| Portkey (free tier 10k req/mo; Pro $99/mo if traffic justifies — bypass fallback available) | $0-99 |
| Anthropic API for sandbox simulator ($5/day cap = $150/mo absolute max; ~$20/mo realistic) | $20-150 |
| Dedicated Gmail account (free) | $0 |
| **Total realistic** | **$65-100/mo** |
| **Worst case (viral moment + Portkey Pro)** | **~$350/mo** |

The viral worst case is bounded by:
- Sandbox `$5/day` hard cap (DO-enforced — see [CLOUDFLARE_PATTERNS.md §4](CLOUDFLARE_PATTERNS.md))
- Owner LLM budget cap (`$5/day` configurable; warning at 80%, hard stop at 100%)
- Portkey free-tier ceiling → automatic bypass to direct Anthropic via `PORTKEY_BYPASS=true` if Portkey rate-limits us

**June 15, 2026 billing change:** Starting June 15, Claude Agent SDK usage stops drawing from your Claude.ai subscription quota and moves to a separate monthly Agent SDK credit pool ($20 Pro / $100 Max 5x / $200 Max 20x), no rollover. For career-pilot, this means we should plan our Anthropic spend assuming **API-rate pay-per-use**, not subscription. The numbers above already assume API-rate pricing — they remain valid. See the [Anthropic notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

**Cost transparency for owner:** the `/admin` page (§17.2) projects burn rate and surfaces remaining-runway estimates. The owner-side Telegram briefing includes daily cost snapshots.

**Cost transparency for visitors:** the `/about` page surfaces aggregate spend honestly — "this system has cost $X so far; here's what the cache saved." Demonstrates engineering discipline + serious investment in landing the role.

### 19. Security & threat model

| Threat | Mitigation |
|---|---|
| Unauthorized Telegram message → drain LLM credits | Chat ID whitelist; reject silently |
| Compromised Portkey API key | OneCLI vault holds it; rotation via `onecli secrets update`; container restart picks it up |
| Compromised Anthropic key | Lives only in Portkey vault, never in our infra; rotate in Anthropic console + Portkey integration |
| Public sandbox abused for cost | Cloudflare Bot Fight Mode → Turnstile → Workers RL (60s burst) → DO per-IP daily cap (10/day) → DO global $5/day cap → output cap. See [CLOUDFLARE_PATTERNS.md §9](CLOUDFLARE_PATTERNS.md). |
| Public sandbox used to extract the candidate's private data | Sandbox agent group has NO access to private DB or Gmail/Calendar — enforced via `disallowedTools` bare-name removal (the tools are stripped from the agent's context entirely so it doesn't even know they exist), reinforced by a per-tool `PreToolUse` hook that blocks calls to any disallowed name, plus the container's mount geometry which does not expose `data/v2.db` to the container at all |
| PII leak via sanitization bug | Three-pass sanitizer; Pass 3 LLM review; failed sanitization drops the event entirely; manual spot-checks via the `ANONYMIZATION DEMO` panel on `/live` + the `/admin` raw-vs-sanitized inspector |
| Contact form spam / abuse | Turnstile invisible captcha with `idempotency_key`; 5 submits/IP/hour via Workers RL |
| SSH access to VM | Cloudflare Access (or IAP); no password auth; key-only |
| Cloudflare Tunnel leak (target address exposure) | Triple defense: CF Access Service Auth + JWT validation at origin + Authenticated Origin Pulls (mTLS) |
| Webhook source spoofing (Gmail, etc.) | Google Pub/Sub push webhooks with shared-secret HMAC or signed JWTs |
| Catastrophic incident | `/killswitch` tier (see PORTAL.md §7 + [RECOVERY.md §3](RECOVERY.md)) — manual SSH-only recovery |

### 20. Configuration-driven design (no hardcoded values)

**Principle:** zero magic numbers in code. Every tunable lives in one of four tiers, each with clear ownership:

| Tier | Stored in | Owner | Hot-reload? | Examples |
|---|---|---|---|---|
| `.env` | File on host VM (gitignored) | Operator (the candidate) | No (restart required) | Hostnames, ports, OneCLI connection info, `PORTKEY_BYPASS`, `LLM_PROVIDER`, `ENABLE_PROMPT_CACHING_1H` |
| `preferences` table | SQLite (`data/v2.db`) | Owner via natural-language Telegram | **Yes** (~5s via system message) | Quiet hours, frequency caps, budgets, channel preferences by message class, briefing schedule, autonomy gradient per action class |
| `system_modes` table | SQLite | Owner via Telegram commands | **Yes** | `LIVE_MODE`, `pause_state`, `pause_reason`, killswitch state |
| `config/defaults.json` | Committed file | Developer (this codebase) | No (it's the seed) | Initial values for `preferences` and `system_modes`; single source of truth for defaults |

The host has a runtime helper `getConfig(key, fallback?)` that reads from the right tier in precedence: env > preferences > defaults.

#### 20.1 What must be configurable (not hardcoded)

| Category | Example | Default | Tier |
|---|---|---|---|
| Polling | `HOST_SWEEP_INTERVAL_SEC` | 60 | `.env` |
| Polling | `ACTIVE_POLL_INTERVAL_SEC` | 1 | `.env` |
| Polling | Gmail poll interval | 60s | preferences |
| Polling | Calendar poll interval | 5min | preferences |
| Budgets | Owner daily LLM budget USD | $5 | preferences |
| Budgets | Sandbox daily USD cap (global) | $5 | preferences |
| Budgets | Sandbox per-IP daily run cap | 10 | preferences |
| Rate limits | Workers RL burst window | 60s | wrangler.toml (binding) |
| Container | Memory limit per session | 512MB | preferences |
| Container | CPU limit per session | 1.0 | preferences |
| Container | Idle timeout | 30 min | preferences |
| Container | Max concurrent | 4 | preferences |
| Cache | Prompt cache TTL strategy | 1-hour | `.env` (`ENABLE_PROMPT_CACHING_1H`) |
| Sanitization | LLM review threshold (chars) | 1000 | preferences |
| Sanitization | LLM review aggressiveness | high | preferences |
| Telegram | Quiet hours | 22:00-07:00 local | preferences |
| Telegram | Frequency cap per day | 8 proactive | preferences |
| Notifications | Channel preference by message class | `{ urgent: telegram, briefing: telegram }` | preferences |
| Onboarding | Required content variables before LIVE_MODE | 5 listed in PORTAL.md §12 | defaults.json |

**Anti-pattern to enforce in code review:** any `const FOO = 60` or `setTimeout(fn, 5000)` without a comment justifying immobility is a flag.

#### 20.2 Hot-reload mechanism

`preferences` and `system_modes` table changes propagate to running containers within ~5 seconds via NanoClaw's native message system:

1. Host watches table mod-time (or SQLite triggers)
2. On change, host writes `messages_in` row of `kind: 'system'`, `action: 'reload_preferences'` to all active sessions
3. Container picks it up on next poll, invalidates its cached `getConfig()` reads
4. Next config read returns the new value

No container restart required. No service restart required. Telegram commands like `/set quiet_hours 22:00-07:00` update preferences and the change takes effect inline.

### 21. CLI tooling reference

The system spans many surfaces. The right CLI for each:

| Task | CLI | Common ops |
|---|---|---|
| GitHub (issues, PRs, releases, repo metadata) | `gh` | `gh pr create`, `gh issue list`, `gh repo view`, `gh api repos/...` |
| GCP (VM, IAM, storage, deployments) | `gcloud` | `gcloud compute instances list`, `gcloud compute ssh ...`, `gcloud iam workload-identity-pools ...` |
| Cloudflare Workers deploy + secrets | `wrangler` | `wrangler deploy`, `wrangler secret put`, `wrangler tail` |
| Cloudflare Tunnel | `cloudflared` | `cloudflared tunnel create`, `cloudflared tunnel route dns`, `cloudflared tunnel login` |
| Cloudflare DNS + zone-level WAF / rate-limit rules | Terraform (`cloudflare.tf`) | `terraform plan`, `terraform apply` |
| Terraform (all infra-as-code) | `terraform` | `terraform validate`, `terraform plan`, `terraform apply -var-file=...` |
| NanoClaw admin (groups, users, sessions, wirings, approvals) | `ncl` | `ncl groups list`, `ncl users grant ...`, `ncl sessions list`, `ncl approvals list` |
| Credential vault | `onecli` | `onecli secrets list`, `onecli secrets update`, `onecli agents set-secret-mode --mode all` |
| Package management (host) | `pnpm` | `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm exec tsx ...` |
| Package management (container/agent-runner only) | `bun` | `bun install`, `bun test`, `bun run typecheck` |
| Local dev orchestration | `docker` | For Ollama + occasional sandbox container debugging |
| DB inspection from skills/scripts | `pnpm exec tsx scripts/q.ts` | `pnpm exec tsx scripts/q.ts data/v2.db "SELECT * FROM applications"` — wraps `better-sqlite3` (no `sqlite3` binary dep) |

**Best practices for Claude Code / coding-agent sessions on this repo:**
- For GitHub data: prefer `gh api repos/...` over `WebFetch` (auth handled, structured JSON)
- For Cloudflare DNS / WAF: use Terraform, not direct API/wrangler — keeps changes reproducible
- For ad-hoc DB queries: `scripts/q.ts` over the `sqlite3` binary (matches NanoClaw's convention)
- For VM operations: prefer `gcloud compute ssh` over manual SSH (handles IAP transparently)
- For one-shot Worker testing: `wrangler tail` to stream logs in real time
- For NanoClaw operations: `ncl` from inside the VM or via SSH; never modify the central DB directly

### 22. Gmail / Calendar OAuth setup walkthrough

Owner-friendly. No prior Google Cloud Console familiarity required.

#### 22.1 Create a dedicated Gmail account first

Per the decision in our review, v1 uses a free dedicated Gmail (e.g., `jane-doe.career@gmail.com`) to keep the personal inbox clean and to isolate OAuth scope. Steps:

1. Open a private/incognito browser window
2. Go to `accounts.google.com/signup`
3. Create the new Gmail account
4. Sign out of your personal Google, sign in to the new one
5. Note the email address — this is what the OAuth flow will authorize

#### 22.2 Create the GCP project for OAuth credentials

(Distinct from the GCP project we use for the VM — could be the same, but cleaner separate.)

1. Sign in to [console.cloud.google.com](https://console.cloud.google.com) with the dedicated Gmail
2. Create a new project: `career-pilot-oauth` (or similar)
3. **Enable APIs:**
   - APIs & Services → Library → search "Gmail API" → Enable
   - APIs & Services → Library → search "Google Calendar API" → Enable
4. **Configure OAuth consent screen:**
   - APIs & Services → OAuth consent screen
   - User type: **External** (because it's a personal Google account, not a Workspace)
   - App name: `Career Pilot`
   - User support email: the dedicated Gmail
   - Developer contact: the dedicated Gmail
   - **Scopes:** Add `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/calendar.events.readonly`
   - **Test users:** Add the dedicated Gmail address itself (only this account will use this app)
   - Save (you'll stay in Testing mode — that's fine; no publishing needed for a single-user app)
5. **Create OAuth client ID:**
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Name: `Career Pilot Backend`
   - Authorized redirect URIs: `https://api.hire.example.com/api/google/callback` (and `http://localhost:3001/api/google/callback` for dev)
   - Click Create
   - Save the **Client ID** and **Client Secret** — these go into `.env`:
     ```env
     GOOGLE_OAUTH_CLIENT_ID=...
     GOOGLE_OAUTH_CLIENT_SECRET=...
     ```

#### 22.3 First-time authorization (happens during onboarding)

After the system is deployed:
1. On the `/admin` page (or via Telegram `/setup gmail`), click "Authorize Gmail/Calendar"
2. You're redirected to Google's consent screen
3. You'll see a "this app isn't verified" warning — click "Advanced" → "Go to Career Pilot (unsafe)". This is expected for a single-user External app in Testing mode
4. Grant the requested scopes
5. You're redirected to `api.hire.example.com/api/google/callback?code=...`
6. The host exchanges the code for tokens, stores the **refresh token** in OneCLI vault (key: `google_oauth_refresh_token`)
7. From then on, the agent can call Gmail/Calendar APIs transparently via OneCLI's proxy

**Token refresh:** access tokens expire hourly. OneCLI auto-refreshes using the stored refresh token. The refresh token itself doesn't expire (unless revoked by the owner from Google account settings).

**Revoking:** if you ever want to cut off the system's Google access:
- From Google: account.google.com → Security → Third-party apps → "Career Pilot" → Remove access
- Or from the system: `onecli secrets delete google_oauth_refresh_token`

### 23. Phase 0 cleanup checklist

The current repo on `nanoclaw-rebuild` still has the old skeleton. Phase 0 fork (per Part V milestone plan) will:

**DELETE outright:**
```
backend/src/db.ts
backend/src/google.ts
backend/src/index.ts
backend/src/orchestrator.ts
backend/src/telegram.ts
backend/Dockerfile
backend/docker-compose.yml
backend/docker-compose.prod.yml
backend/package.json
backend/package-lock.json
backend/README.md
backend/tsconfig.json
backend/node_modules/                  # gitignored anyway
frontend/src/app/page.tsx
frontend/src/app/layout.tsx
frontend/src/app/globals.css
frontend/src/app/favicon.ico
frontend/AGENTS.md
frontend/CLAUDE.md
frontend/eslint.config.mjs
frontend/next.config.ts
frontend/next-env.d.ts
frontend/open-next.config.ts
frontend/package.json
frontend/package-lock.json
frontend/postcss.config.mjs
frontend/public/                       # static assets (review individually first)
frontend/README.md
frontend/tsconfig.json
frontend/wrangler.toml
frontend/node_modules/
SETUP.md                               # superseded by nanoclaw.sh + scripts/setup-local.ts
```

**ARCHIVE (move to `.specs/v1-archive/`):**
```
.specs/feasibility_analysis.md
.specs/implementation_plan.md
.specs/verification_playbook.md
.specs/component_backend.md
.specs/component_frontend.md
.specs/component_infrastructure.md
```
(Useful for context / diff reference, but superseded by PORTAL.md + STRATEGY.md.)

**ADAPT (keep + rewrite heavily):**
```
README.md                              # rewrite — generic-by-design, points to .specs/
CLAUDE.md (root)                       # rewrite — orient Claude Code to new structure
.gitignore                             # add: data/, sessions/, .claude-host-fragments/,
                                       #      .env*, !.env.example, *.dev.db,
                                       #      logs/, .onecli-vault/
.github/workflows/deploy-frontend.yml  # rewrite from scratch (TanStack Start + wrangler)
.github/workflows/deploy-backend.yml   # rewrite from scratch (gcloud + pnpm + systemctl)
infra/main.tf                          # e2-small → e2-medium; COS → Ubuntu 24.04
infra/cloudflare.tf                    # add api.hire CNAME, Tunnel, Access service-auth, AOP
infra/variables.tf                     # new variables: cf_access_aud, tunnel_id, etc.
infra/templates/user-data.yml.tpl      # rewrite — Ubuntu cloud-init for NanoClaw + OneCLI
```

**KEEP unchanged:**
```
.git/                                  # commit history
.specs/PORTAL.md
.specs/STRATEGY.md                     # this doc
.specs/AGENT_SDK_PATTERNS.md
.specs/CLOUDFLARE_PATTERNS.md
.specs/RECOVERY.md
.specs/V2_IDEAS.md
.specs/v1-archive/                     # the moved-aside old specs
```

**ADD (from NanoClaw v2 upstream — `git clone https://github.com/nanocoai/nanoclaw.git` into a sibling working dir, copy in):**

Everything that NanoClaw v2 ships: `bin/`, `scripts/` (NanoClaw's own), `setup/`, `launchd/`, `container/`, `docs/` (NanoClaw's), `config-examples/`, `repo-tokens/`, `assets/`, `src/` (NanoClaw's host), `nanoclaw.sh`, `pnpm-workspace.yaml`, root `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `migrate-v2.sh`, etc.

**THEN ADD (career-pilot specifics, the part that's actually our work):**

- `groups/career-pilot/` — owner agent group folder (CLAUDE.md, .claude/agents/, skills/, agent-runner-src/mcp-tools/)
- `groups/career-pilot-sandbox/` — public simulator agent group folder
- `groups/_shared-skills/` — skill code shared between owner and sandbox
- `src/modules/portal/` — Express API, sanitization, public_audit_trail, system modes, simulator orchestration, contact relay
- `src/channels/portal/` — the new `portal` channel adapter for the web simulator
- `src/db/migrations/100-107` — career-pilot tables
- `frontend/` — fresh TanStack Start project (new layout, see PORTAL.md §3.5)
- `config/defaults.json` — seed values for preferences + system_modes
- `scripts/setup-local.ts` — the idempotent setup script (§16.3)
- `scripts/reset:dev.ts` — clean-state reset (§16.5)
- `scripts/recover-from-killswitch.sh` — manual recovery procedure
- `scripts/sync-shared-skills.ts` — copy `_shared-skills/` into both agent groups

**The Phase 0 commit will be huge** (probably 200+ files from NanoClaw + scaffolding for our additions). Plan: one commit landing the NanoClaw tree as-is, then a second commit adding our scaffolding (empty career-pilot agent group skeletons, the modules/portal/ directory tree with placeholder index.ts, the migrations files with empty bodies, etc.). Subsequent phases fill in the bodies.

---

## Part V: Milestone plan

10-week phased delivery from "branch created" to "portal live, LIVE_MODE=true."

| Phase | Week | Deliverable | Definition of done |
|---|---|---|---|
| **0. Foundation** | 1 | Fork NanoClaw, get vanilla NanoClaw running locally with Telegram | I can `/start` the bot, it responds. Container spawns, session DBs created. |
| **1. Career-pilot agent group** | 2 | `groups/career-pilot/`, migrations 100-107, first MCP tools | Agent has a persona; I can say "add an application for X" and it writes to the DB and confirms. |
| **2. Subagents + skills** | 3 | 5 subagent definitions, skill instructions, remaining MCP tools | I can paste a JD and ask "tailor my resume" — agent invokes research-company + tailor-resume, returns tailored bullets. |
| **3. Sanitization + public_audit_trail** | 4 | `src/modules/portal/sanitizer.ts`, post-write hooks, sanitized mirror to `public_audit_trail` | Every funnel_event has a matching sanitized row in public_audit_trail. Spot check: real company name nowhere in public table. |
| **4. Portal backend** | 5 | Express API, SSE infra, system modes, portal channel adapter, sandbox agent group | I can `curl /api/funnel` and get real (sanitized) data. SSE stream emits events. `POST /api/simulator` spawns a sandbox container. |
| **5. Frontend bootstrap** | 6 | **TanStack Start docs deep-read** + scaffold + landing + /work | Hero renders. Live ticker connects to SSE. /work renders with placeholders. |
| **6. Frontend depth** | 7 | /live, /funnel, /architecture pages | All three pages render real data. Filter chips work. Funnel race animates. |
| **7. Simulator end-to-end** | 8 | /simulator interactive sandbox | A visitor can type a company + JD, hit Run, see real streaming output side-by-side. Sandbox session tears down cleanly. |
| **8. Polish + deploy** | 9 | Cloudflare deploy pipeline, /about content, /contact form, content placeholders | `hire.example.com` resolves to the deployed Worker. /contact submission lands in Telegram. /about reads honestly. |
| **9. Shadow run** | 10 | Deploy with `LIVE_MODE=false`; system runs in shadow for 1-2 weeks | I'm comfortable flipping `LIVE_MODE=true`. All proactive behaviors observed without external side effects. |
| **10. Go live** | 11 | `LIVE_MODE=true`; real outreach starts | First real recruiter contact submitted via /contact form. First real outreach approved + sent. Portal shares to LinkedIn / wherever. |

Each phase ends with a commit-and-pause for review. Phases 0-3 are mostly invisible (backend plumbing); phases 4-7 are where the portal starts coming alive. Phase 9 is the soft-launch buffer your "I want to test in production before it can affect my life" instinct demands.

**Out of scope for v1 (move to a `v2-ideas.md`):**
- Multi-user / SaaS-ification
- Discord channel (will add via `/add-discord` post-v1 — half-day of work)
- Public Discord/Telegram bots for visitors to chat with
- Voice interface
- Auto-apply (no — always human-in-the-loop for v1)
- Mobile native app (the responsive web is enough)

---

## Part VI: Open questions

1. **Where exactly do we host OneCLI?** It runs as a local proxy at `127.0.0.1:10254` on the host. For local dev: same. For prod: it must run as a sidecar service or as a container on the VM. NanoClaw's `/init-onecli` skill handles this — assume their docs cover it, verify during Phase 0.

2. **Cloudflare Tunnel + SSE longevity:** Cloudflare Tunnel works for SSE but has connection-idle timeouts. Need to verify the default timeout is >5 minutes (our session ceiling) or configure keep-alives. Verify during Phase 4.

3. **TanStack Start RC churn risk:** Pin the exact RC version we start with. Don't auto-update. Re-evaluate at end of Phase 7 whether to upgrade. If 1.0 ships during our build, evaluate the upgrade then.

4. **Portkey free tier ceiling:** 10k req/mo. Each agent turn = ~3-5 LLM calls (orchestrator + 1-3 subagents). 100 turns/day = 12-15k/mo. We'll likely need Portkey Pro within weeks. Budget $99/mo or stick with free until we hit the wall — start free, upgrade reactively.

5. **What's the URL for the public Telegram bot for visitors?** PORTAL.md §5.7 mentions one as an alternative contact path. Do we actually want a public Telegram bot, or drop it and rely only on the contact form? Recommendation: drop for v1 (the contact form covers it).

6. **Ollama in local dev vs eval-quality testing:** Llama 3.2 vs Claude output quality is night-and-day for nuanced tasks. We'll need a small budget for "real" testing of resume tailoring quality. Recommend $20/mo Anthropic budget for dev/testing.

7. **Initial obfuscated_label assignment:** What's the function that turns a JD into an industry label (`fintech-b` vs `ai-infra-a`)? Probably a simple LLM call on first JD analysis, cached per company. Confirm during Phase 1.

8. **Headshot for /work:** If the candidate has one, easy. If not, we'll need a clean illustration or skip the headshot block. Owner decision pre-Phase 8.

---

## Part VII: What's next after STRATEGY.md

This doc is the architectural plan. The next concrete deliverables:

1. **CLAUDE.md (repo root) — rewritten** for the new structure. Orientation doc for any Claude Code session opening this repo: where things live, what tooling we use, what conventions we follow. Replaces the current `CLAUDE.md` which is stale.

2. **README.md — rewritten** for the new structure. Generic-by-design (career-pilot is meant to be forkable). Points to PORTAL.md and STRATEGY.md for depth.

3. **Phase 0 execution** — fork NanoClaw into this branch. The actual code-landing-on-disk step. Will be a meaningfully large commit (~150 files from NanoClaw + our scaffolding). Stop for review after fork lands.

4. **Migration files for the 8 new tables.** Phase 1's prerequisite.

5. **`groups/career-pilot/CLAUDE.md`** — the owner agent's persona doc. The single most important piece of writing in the system, because it shapes every agent decision. Worth its own focused writing session.

After STRATEGY.md sign-off, the order of operations is: rewrite root CLAUDE.md + README → Phase 0 fork → Phase 1 schema + first MCP tools → Phase 2... working forward.

Estimated total work to LIVE_MODE=true: ~10-11 weeks of focused part-time effort (assumes ~15-20 hours/week). Tighter if full-time; longer if intermittent.
