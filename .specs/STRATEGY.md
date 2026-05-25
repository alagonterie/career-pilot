# STRATEGY.md — Backend, Infrastructure, and Delivery Plan

This is the back-derivation from [PORTAL.md](PORTAL.md). PORTAL.md says *what* the portal must surface; this doc says *how* we build it.

Reading order: PORTAL.md first, then this.

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
│   │   ├── CLAUDE.md                 (committed; persona + rules, no PII)
│   │   ├── persona.local.md          (gitignored; populated from candidate_profile)
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

**CLAUDE.md (committed, generic):**

The persona/role description for Jane's primary assistant. Contains:
- The agent's overall mission: "Manage Jane's job search end-to-end"
- The autonomy gradient (§6.3 of PORTAL.md) codified as concrete dos/don'ts
- The voice: technical, warm, brief, never sycophantic
- The reflection prompting style (for rejection-as-fuel)
- Quiet hours default behavior
- Where to find candidate persona content (the gitignored `persona.local.md`)

`persona.local.md` is *generated at runtime* from the `candidate_profile` table by a host-side hook that runs on session creation. Gitignored. Recreated whenever the profile changes.

**Container config (`container_configs` table row):**
- All subagents available
- All in-process MCP tools available, including DB-write and `send_outreach_email` (gated by LIVE_MODE + approval card)
- OneCLI scope: full (access to Google OAuth, Telegram, Portkey, Cloudflare)
- Model: `@anthropic-prod/claude-opus-4-7` (Portkey AI Provider)
- Memory: `user` (per Claude Agent SDK options)

**Wiring (`messaging_group_agents`):**
- Telegram (Jane) → `career-pilot`, `session_mode='shared'`, owner-only via `user_roles`

#### `groups/career-pilot-sandbox/` — public simulator agent group

**CLAUDE.md (committed, generic):**

A shorter persona for the simulator. Explains:
- "You're running in sandbox mode — a recruiter is testing what this system can do"
- Read-only: no DB writes, no real outreach, no Gmail/Calendar
- Output bounded by a strict token cap to avoid runaway cost
- End cleanly when the run completes

**Container config:**
- Subagents: `research-company`, `tailor-resume`, `draft-outreach` only (no `prep-interview`, no `scrape-jobs`)
- MCP tools: only `analyze_jd`, `sanitize_text` — **explicitly excludes** `update_application`, `record_funnel_event`, `save_outreach_draft`, `send_outreach_email`, `query_gmail`, `query_calendar`
- OneCLI scope: separate sub-vault `career-pilot-sandbox` containing only a sandbox-specific Portkey API key with a separate spend cap
- Model: `@anthropic-sandbox/claude-opus-4-7` (Portkey AI Provider with separate budget)
- Memory: `local` (per-session; no cross-session memory)
- `maxTurns`: 30 (hard cap on agent turns to prevent runaway)

**Wiring:**
- `portal` channel → `career-pilot-sandbox`, `session_mode='per-thread'` — each visitor gets a fresh isolated session

#### Skill code: shared between owner & sandbox

The skill *instructions* (the markdown `SKILL.md` files in `skills/<name>/`) are duplicated between both agent groups via a build-time copy from a shared `groups/_shared-skills/` directory. The container's tool allowlist (set in `container_configs`) determines which MCP tools are available — same skill prompt, different tool palette.

A `scripts/sync-shared-skills.ts` script runs on host startup and after any commit touching `groups/_shared-skills/`. Idempotent.

### 5. Subagent designs

Five subagents, all read-only. Defined as filesystem agents in `.claude/agents/<name>.md`. The Claude Agent SDK loads them automatically (per the SDK docs).

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
tools: [Read]   # only reads the persona.local.md file inside the workspace
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

Defined using the Claude Agent SDK's `tool()` helper. All live in `groups/career-pilot/agent-runner-src/mcp-tools/`. Loaded into both agent groups' containers (with the sandbox's tool allowlist filtering them out where appropriate).

| Tool | Args (Zod) | Side effect | Owner | Sandbox |
|---|---|---|---|---|
| `analyze_jd` | `{ text_or_url: string }` | none | ✓ | ✓ |
| `parse_email` | `{ raw: string }` | none (via Haiku) | ✓ | ✗ |
| `sanitize_text` | `{ raw: string, application_id?: string }` | none (regex + DB lookup) | ✓ | ✓ (no application_id) |
| `update_application` | `{ id: string, patch: object }` | DB write `applications` | ✓ | ✗ |
| `record_funnel_event` | `{ application_id: string, kind: string, payload: object }` | DB write `funnel_events`; mirrors to `public_audit_trail` via post-write hook | ✓ | ✗ |
| `save_outreach_draft` | `{ application_id: string, draft: object }` | DB write `funnel_events` (kind `outreach_drafted`) | ✓ | ✗ |
| `send_outreach_email` | `{ application_id: string, draft: object }` | **EXTERNAL**: sends via Gmail; gated by LIVE_MODE + approval card | ✓ | ✗ |
| `schedule_followup` | `{ application_id: string, when: ISO8601, prompt: string }` | NanoClaw native `schedule_task` invocation | ✓ | ✗ |
| `get_application` | `{ id: string }` | none | ✓ | ✗ |
| `list_applications` | `{ filter?: object }` | none | ✓ | ✗ |
| `query_gmail` | `{ query: string, since?: ISO8601 }` | none (proxied via OneCLI) | ✓ | ✗ |
| `query_calendar` | `{ range: { start, end } }` | none (proxied via OneCLI) | ✓ | ✗ |
| `add_learning` | `{ application_id?: string, kind: string, reflections: object }` | DB write `learnings` | ✓ | ✗ |
| `update_profile_field` | `{ field: string, value: any }` | DB write `candidate_profile` | ✓ | ✗ |

Each tool is a single TS file in `mcp-tools/`. The barrel `mcp-tools/index.ts` registers all tools; the container's `container.json` `tools` array filters which are exposed to the agent.

---

## Part III: Integration surfaces

### 7. Channel adapters

#### Telegram

Installed via NanoClaw's `/add-telegram` skill, which clones the adapter from the `channels` branch of `nanocoai/nanoclaw` into `src/channels/telegram/`. Configuration:

- Bot token in OneCLI vault (key: `telegram_bot_token`)
- `ALLOWED_TELEGRAM_CHAT_ID` env var = Jane's chat ID (drops messages from any other ID)
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

All routes return JSON. All routes are read-only or write-only-via-relay (contact form). Authentication: none for read endpoints (they're sanitized); per-IP rate limit + Turnstile for write endpoints.

```
GET  /api/funnel
GET  /api/activity?since=<ts>&limit=50
GET  /api/activity/stream                  ← SSE
GET  /api/telemetry
GET  /api/architecture
POST /api/simulator                        ← spawns sandbox session
GET  /api/simulator/:id/stream             ← SSE
GET  /api/simulator/results/:id
POST /api/contact                          ← spam-controlled relay
GET  /api/system-status                    ← LIVE_MODE / pause state / health
```

CORS: explicit allow-list (`hire.example.com` + dev origins). No `*`.

Server-Sent Events use the `text/event-stream` MIME with `data:` framing. Cloudflare Tunnel handles SSE transparently; no special config required.

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

Recovery from killswitch is intentionally manual — `/resume` doesn't work. Owner must SSH, run a recovery script that re-issues OneCLI tokens, resets Portkey budget, and clears the killswitch flag.

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

Container env on session start contains only OneCLI connection vars + the Portkey base URL. Everything else is injected at request time by OneCLI.

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

**Why e2-medium not e2-small:** NanoClaw spawns one container per active session (Bun, ~200-400 MB). With Jane's owner session + up to 3 simultaneous sandbox sessions + the host node process + cloudflared, we need ~2-3 GB working set. e2-small (2GB) would OOM under any load. e2-medium has headroom.

**Cloudflare:**

| Surface | Service | Config |
|---|---|---|
| `hire.example.com` | Cloudflare Worker | TanStack Start build via `wrangler deploy` |
| `api.example.com` | Cloudflare Tunnel → cloudflared container on VM | Auth: `X-Career-Pilot-Auth` header signed via shared secret |
| DNS for both | Cloudflare DNS | CNAMEs via Terraform |
| Analytics | Cloudflare Web Analytics | Free, privacy-respecting; site tag injected by the Worker |
| Spam | Cloudflare Turnstile | `/contact` and `/simulator` POST endpoints |

VM has no public HTTP ports open. SSH (`tcp/22`) is the only public port, and we'll lock it down to Identity-Aware Proxy (IAP) ranges if possible — see `iac/main.tf` firewall rule.

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

Goal: full E2E (Telegram → agent → DB → portal SSE event → frontend live update) running on Docker Desktop, no Anthropic API spend.

**Local stack:**
- NanoClaw host runs natively (`pnpm dev`) — faster iteration than dockerized
- Ollama runs in a Docker container with GPU passthrough enabled if available
- Agent containers run via local Docker
- TanStack Start dev server runs natively (`pnpm dev` in `frontend/`)
- A separate dev Telegram bot token (so we don't fight the prod bot)
- `LLM_PROVIDER=ollama` env var routes all LLM calls through Ollama via NanoClaw's `/add-ollama-provider` skill

**Setup script (local):** `bash scripts/setup-local.ps1` (Windows / WSL2) / `setup-local.sh` (mac/linux):
1. Check prerequisites (Node, pnpm, Docker)
2. Run `pnpm install`
3. Start Ollama container
4. Pull `llama3.2` model: `docker exec ollama ollama pull llama3.2`
5. Run NanoClaw setup (interactive Telegram pairing for dev bot)
6. Apply migrations
7. Print "Ready — run `pnpm dev` to start the host and `cd frontend && pnpm dev` for the portal"

**Trade-off:** Ollama with `llama3.2:3b` will produce noticeably worse output than Opus 4.7 — bullet quality, outreach voice, all weaker. That's fine for plumbing tests. For "what would the simulator actually output for a recruiter" tests we'll selectively flip to Claude with a small per-test budget.

### 17. Observability

| Signal | Source | Surfaced where |
|---|---|---|
| LLM cost / cache rate / token usage | Portkey Analytics API | `/api/telemetry` → `/live` panel |
| Active sessions / containers | NanoClaw central DB + Docker | `/api/architecture` → `/architecture` page |
| Agent trace events | `public_audit_trail` (sanitized) | `/api/activity` + SSE → `/live` stream |
| Host process health | systemd + `journalctl` | `/api/system-status` |
| Error/crash logs | `logs/career-pilot.error.log` + Telegram alert channel | Owner via Telegram + `/about` cost panel |
| Simulator runs (success/failure rate) | `simulator_runs` table | `/api/telemetry` |

The Telegram alert channel (separate from the chat channel) gets a message whenever:
- Host process crash/restart
- Sanitization Pass 3 flagged content (requires owner review)
- LIVE_MODE state change
- Daily spend approaches budget cap (warn at 80%, hard cap at 100%)
- Killswitch triggered

### 18. Cost model

Realistic monthly estimate:

| Item | Estimate |
|---|---|
| GCP e2-medium (us-central1, sustained use) | $13 |
| GCP egress (minimal, mostly via Cloudflare Tunnel) | $1-3 |
| Cloudflare Workers (free tier covers 100k req/day) | $0 |
| Cloudflare Tunnel | $0 |
| Cloudflare DNS | $0 |
| Domain renewal (example.com) | $1/mo amortized |
| Anthropic API via Portkey (Jane's actual usage, with caching) | $30-80 |
| Portkey (free tier 10k req/mo; Pro $99 if portal goes viral) | $0-99 |
| Anthropic API for sandbox simulator (capped at $5/day = ~$150/mo worst case; ~$20/mo realistic) | $20-150 |
| **Total realistic** | **$65-100/mo** |
| **Worst case (viral moment, paid Portkey)** | **~$350/mo** |

The viral worst case is bounded by the daily spend cap on the simulator — even if the portal hits HN front page, the sim auto-disables at $5/day.

### 19. Security & threat model

| Threat | Mitigation |
|---|---|
| Unauthorized Telegram message → drain LLM credits | Chat ID whitelist; reject silently |
| Compromised Portkey API key | OneCLI vault holds it; rotation via `onecli secrets update`; container restart picks it up |
| Compromised Anthropic key | Lives only in Portkey vault, never in our infra; rotate in Anthropic console + Portkey integration |
| Public sandbox abused for cost | Per-IP rate limit (10 runs/day); $5/day total cap; sandbox container `maxTurns=30`; sandbox uses a separate Portkey AI Provider with its own budget |
| Public sandbox used to extract Jane's private data | Sandbox agent group has NO access to private DB or Gmail/Calendar; tools enforced via container config (defense in depth) |
| PII leak via sanitization bug | Three-pass sanitizer; Pass 3 LLM review; failed sanitization drops the event entirely; manual spot-checks via the `ANONYMIZATION DEMO` panel on `/live` |
| Contact form spam / abuse | Turnstile invisible captcha; 5 submits/IP/hour |
| SSH access to VM | Cloudflare Access (or IAP); no password auth; key-only |
| Webhook source spoofing (Gmail, etc.) | Google Pub/Sub push webhooks with shared-secret HMAC or signed JWTs |
| Catastrophic incident | Killswitch tier (§7 PORTAL.md) — manual SSH-only recovery |

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

8. **Headshot for /work:** If Jane has one, easy. If not, we'll need a clean illustration or skip the headshot block. Owner decision pre-Phase 8.

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
