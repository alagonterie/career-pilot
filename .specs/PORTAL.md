# hire.example.com — Portal UX Specification

This is the primary deliverable of the `career-pilot` project. The backend exists to feed this portal a compelling, real, live story. Every architectural decision downstream should be judged against "does this surface something undeniable to a visitor?"

This document specs the portal experience end-to-end. The backend [STRATEGY.md](STRATEGY.md) (to be written next) back-derives from this spec.

---

## 1. Vision & success metric

A visiting recruiter or hiring manager lands on `hire.example.com`, spends 30–120 seconds on the page, and converts in one of three ways:

1. **Direct contact** — submits the contact form or DMs the candidate via a surfaced channel.
2. **Forward up** — sends the link to their engineering hiring manager / EM / staff engineer with a positive framing.
3. **Pipeline pull** — adds the candidate to their pipeline for a specific open role.

The portal succeeds when **technical hiring managers who see this page conclude, within 60 seconds of digging in, that the candidate ships real systems**. Recruiter conversion is downstream of that conclusion.

**Anti-goals:**
- Looking clever without proving substance (vibe over substance is disqualifying).
- Burying the resume/contact path behind the gimmick.
- Sharing real-time PII or active-application company names (legal/professional risk).
- Mock/demo data unlabeled as such on the deep-view page.

---

## 2. Audience model & visitor journey

| Visitor | Path | Conversion goal |
|---|---|---|
| **Non-technical recruiter / sourcer** | Lands on `/`, sees hero + funnel + "try it" CTA, plays with simulator, submits contact form | Contact form submission |
| **Technical recruiter / TPM** | Lands on `/`, glances at hero, clicks "see it work" → `/live`, watches activity for 30s, returns to `/` for contact | Contact form submission with role context |
| **Engineering hiring manager / Staff engineer** | Lands on `/`, scans hero, clicks through to `/live` and `/architecture`, opens GitHub repo in new tab, returns to `/contact` if convinced | Personal email to the candidate, or recruiter handoff |
| **Curious peer engineer** | Lands on `/`, dives into `/architecture` and GitHub, reads the actual code | Stars repo, follows on socials, may reach out |
| **The person being shown the link by the candidate** | Direct deep link to a specific page they're sent | Whatever the conversation calls for |

The first three are the priority. Design every page to read fast for #1, reward dig-in for #3.

### The visitor journey — mouth, hub, spokes, and a single sink

The persona paths above all share one shape: **land → get gripped → deepen on what interests you → convert.** The portal has to make that shape *physical*. Two failure modes to design against — both currently latent in the built surfaces:

1. **The one-shot dead-end.** A visitor clicks the hero's one CTA, lands on a single deep page, and stops. The page impresses but offers no next step, so an interested visitor leaks out the back instead of going deeper or converting.
2. **No sink.** Every persona path terminates in *contact* — but if there's nowhere obvious to convert at the moment of conviction, the whole funnel is decorative.

The model that prevents both:

```
   /  — the funnel mouth
   hero · funnel strip · live ticker · simulator pitch · resume+contact teaser
        │  (each viewport hands the visitor a directed next step)
        ▼
   /live  — the hub / branch point  ◄── the one register-crossing CTA lands here
        │
        │   "is this real?"        "prove it on me"        "I'm convinced"
        ▼                              ▼                         ▼
   /architecture → repo          /simulator                 /contact
        │   (depth, skeptic)      (personalized proof,        — THE SINK —
        │                          pre-fills contact)         every path drains
        └───────────────┬──────────────┘                     here; carries the
                        ▼                                      role/company/from
                     /contact  ◄───────────────────────────── context

   top nav (§8.1) lets a visitor jump to any surface at any time;
   the connective rail (§8.4) pulls them forward toward /contact.
```

- **The home is the funnel mouth.** Its five viewports (§5.1) *are* connective tissue: each hands off a directed next step (funnel strip → `/funnel`, live ticker → `/live`, simulator pitch → `/simulator`, resume teaser → `/work` + `/contact`). A fully-built home channels; a hero-only home leaks.
- **`/live` is the hub.** It's where the one register-crossing CTA lands (§3.5) and where intent forks: the skeptic deepens into `/architecture` + the repo, the "prove-it" visitor pivots to `/simulator`, the convinced visitor converts at `/contact`.
- **`/contact` is the single sink.** Every surface offers a path to it, and it accepts **carried context** (the role/company a simulator run was about, the surface the visitor came from) so converting is one low-friction step, not a cold form.
- **Every deep surface offers a next step.** No `/live`, `/funnel`, `/architecture`, `/simulator`, or `/work` is a terminus: each carries the **connective rail** (§8.4) — a constant convert path (→ `/contact`) plus 1-2 contextual deepen/pivot options. The top nav (§8.1) independently supports free "bounce anywhere" movement; the rail adds *directed* pull so an interested visitor is led forward rather than left to find their own way.

This journey is not new scope invented here — it's the persona paths above + the §3.5 register transitions made physical. What it adds is the **connective tissue**: the rail (§8.4), the home build-out (§5.1), and a real `/contact` sink (§5.7) — turning five strong-but-isolated surfaces into a path that deepens and converts. STRATEGY.md §24.30 carries the delivery decomposition (the "conversion spine").

---

## 3. Style guide — "Apple hero, Bloomberg gut"

The portal is visually split between two registers:

### A. Landing register: Apple/Linear cleanness
Used on `/`, `/work`, `/contact`. Generous whitespace, large typography, restrained color, one focal element per viewport-height. Conveys product taste; doesn't intimidate the non-technical visitor.

### B. Operations register: Bloomberg/mission-control density
Used on `/live`, `/funnel`, `/architecture`. Dense multi-panel layouts, monospace numeric data, streaming text, abundant real-time signals. Conveys engineering depth; rewards visitors who clicked "see it work."

A visitor moves between registers via deliberate transitions. The landing page hero contains exactly one CTA that crosses the register boundary: `[ See it work → ]` → opens `/live`.

### Color & typography

```
Foundation (landing register)
  --bg            220 14% 6%         /* near-black, slight cool tint     */
  --surface       220 14% 9%         /* card                              */
  --border        220 10% 16%        /* hairlines                         */
  --text          0 0% 96%           /* primary                           */
  --text-muted    220 10% 64%        /* secondary                         */

Accent (used sparingly on landing, freely on ops)
  --accent        160 80% 50%        /* signal green                      */
  --accent-cool   200 90% 60%        /* cyan, for traces/links            */
  --warn          38 95% 60%         /* warning (rare; used for "demo")   */
  --danger        0 75% 60%          /* failures (never on landing)       */

Ops-mode extras
  --grid          220 12% 13%        /* terminal grid lines               */
  --glow          160 80% 50% / 0.4  /* pulsing live indicator            */
```

Typography: `Inter` (variable) for body/UI, `JetBrains Mono` for all numerics, IDs, log lines, code. Display weight 700 for hero, 600 for section heads, 500 for body, 400 for table cells. Line height 1.45 in landing register, 1.3 in ops register (denser).

Motion: limited. The only auto-animating element on `/` is a single pulsing "● live" indicator next to the funnel. On `/live`, log lines stream in (no smooth scroll — discrete append, like a real terminal). No parallax. No scroll-jacked stories. Recruiters skim; we don't fight them.

### Component register

| Component | Register | Notes |
|---|---|---|
| `StatusPill` | Both | Real-time on `/`; one per system status (e.g. "🟢 OPEN FOR OFFERS") |
| `LiveTicker` | Both | Compact on `/`, expanded on `/live` |
| `FunnelStrip` | Both | Compact 5-stage strip on `/`, full-detail board on `/funnel` |
| `Card` | Landing | Glass-y surface, used for resume content, contact form |
| `Panel` | Ops | Bordered, dense, no padding |
| `LogStream` | Ops | Append-only terminal-like component, monospace |
| `ArchDiagram` | Ops | Live system map with status badges |
| `TraceLine` | Ops | Single agent invocation row with model, latency, cost, cache state |
| `Simulator` | Hybrid | Apple-clean shell, ops-style streaming output |

### Frontend framework & libraries (locked)

| Layer | Choice | Notes |
|---|---|---|
| Framework | **TanStack Start** (v1, stable since 2026-03) | Vite-native, type-safe routing end-to-end, server-functions RPC model. Cloudflare Workers is an official partner integration (deploy via `@cloudflare/vite-plugin`). |
| Routing | **TanStack Router** (bundled with Start) | File-based or code-based; full type inference for params, search params, loader returns; deep-link safety enforced by the compiler. |
| Build tool | **Vite** | Fast HMR, mature plugin ecosystem (Vitest, vite-plugin-*). |
| Cloudflare deploy | **Cloudflare Workers** (`@cloudflare/vite-plugin`) | `wrangler.jsonc` + the CF Vite plugin (`main: '@tanstack/react-start/server-entry'`); `vite build` → `wrangler deploy`. |
| Worker runtime | **`nodejs_compat`** flag enabled | Required for several shadcn deps and `crypto`/`Buffer` use; SSE works fine. |
| Styling | **Tailwind v4** | `@theme` directive, OKLCH color tokens, layered registers via CSS variables. |
| UI primitives | **shadcn/ui (new-york)** on Radix UI | Framework-agnostic; works identically under TanStack Start. |
| Motion | **`motion/react`** | The renamed successor to Framer Motion. |
| Virtualized lists | **`@tanstack/react-virtual`** | Powers `LogStream` and dense trace tables. (Same TanStack family — clean integration.) |
| ANSI parsing (logs) | **`anser`** | Lightweight ANSI → React nodes. |
| Icons | **Lucide React** | shadcn default. |
| Forms | **`react-hook-form` + Zod** | Pairs naturally with TanStack Router's typed search params. |
| Analytics | **Cloudflare Web Analytics** | Privacy-respecting, free with Workers. |

**Why TanStack Start (vs Next.js 15):**

- **Type-safe routing end-to-end.** Every route param, search param, loader return, and `<Link>` target is inferred by the compiler. Critical for our dashboard pages with multi-param state: `/live?filter=tailor&since=<ts>`, `/funnel?reveal=fintech-b`, `/simulator/results/:id`. Rename a route → TS catches every call site.
- **No RSC mental tax.** Server functions are typed RPC; no `"use client"`/`"use server"` poisoning, no "can't import from server component" footguns, no hydration-mismatch landmines.
- **Smaller framework footprint** → easier to stay under the 3 MiB Cloudflare Worker compressed bundle cap (free tier).
- **Engineering-taste signal.** The audience for this portal includes engineering hiring managers and senior peers — they recognize TanStack Start as a thoughtful 2026 choice. Next.js is universally recognized but uninteresting.

**Trade-off accepted:** TanStack Start reached v1.0 (stable, 2026-03) — the RC churn risk is gone; we pin a v1 minor and upgrade deliberately, not automatically. The app code (React + shadcn + business logic) is ~95% framework-agnostic, so a Next.js fallback remains a ~one-day port if ever needed.

**Architectural rules:**

1. **Nested-route layouts** for the two visual registers. `routes/(marketing)/_layout.tsx` for the landing register, `routes/(ops)/_layout.tsx` for the operations register. Tailwind density tokens swap based on the layout context.
2. **No global client instantiation in server functions or route loaders.** Required by the Worker runtime — `I/O streams cannot cross request handlers`. HTTP clients, SSE readers, etc. live inside the handler body.
3. **3 MiB compressed Worker budget on Cloudflare's free tier.** Audit any dep addition. TanStack Start ships less framework code than Next.js, giving more headroom.
4. **SSE consumers** prefer `fetch`-with-stream-reader over `EventSource` so we can set custom headers (e.g., auth) — and to multiplex over HTTP/2 (Cloudflare default), sidestepping the browser 6-connection HTTP/1.1 cap on `EventSource`.
5. **Server functions for forms.** `/contact` submission flows through a TanStack Start server function (typed RPC) that calls the native-`http` backend via Cloudflare Tunnel. No client-side API key handling.
6. **Search params as first-class state.** Filter chips on `/live`, reveal toggles on `/funnel`, and pagination on `/simulator/results` use TanStack Router's typed `useSearch()` instead of ad-hoc URL parsing — deep-linkable, type-safe, refresh-safe.

**Implementation discipline:** Before any frontend code lands, we do a focused TanStack Start docs pass (v1 changelog, the `@cloudflare/vite-plugin` deploy path, server-functions API, search-param typing patterns) and capture canonical patterns for our specific needs (SSE streaming, server-function error handling, route prefetching). Done — captured in STRATEGY.md §24.23.

**Alternative considered:** Next.js 15 App Router on `@opennextjs/cloudflare`. It's the safer/universally-recognized pick — production-locked, larger community, more recipes for SSE-on-Workers patterns. We're trading some of that recognition for type-safety wins, smaller bundles, and the taste signal. If TanStack Start ever feels like it's costing us more than it's giving us, the fallback is a one-day port.

---

## 4. Site map

```
/                    Landing — hero + funnel + activity hook + simulator CTA
/live                Real-time ops dashboard (the "dig in")
/simulator           Recruiter Simulator (interactive sandbox)
/funnel              Funnel race detail + history + outcomes
/architecture        Live system architecture + current state
/work                Resume / experience / projects / writing
/contact             Recruiter contact form + direct contact options
/about               Why this exists, methodology, FAQ (footer link only)

API routes (consumed by the frontend)
/api/funnel          GET — sanitized funnel state
/api/activity        GET — sanitized recent activity (last 50 events)
/api/activity/stream GET — SSE stream of live sanitized events
/api/telemetry       GET — aggregate metrics (cache rate, cost, etc.)
/api/architecture    GET — live system status (sessions, containers, etc.)
/api/simulator       POST — start a sandbox simulation; returns simulation_id
/api/simulator/:id   GET — SSE stream of simulator results
/api/contact         POST — relay to the candidate's Telegram
```

Public routes are TanStack Start pages running on Cloudflare Workers. Route loaders hit the backend API via server functions (the Worker proxies to the GCP VM through Cloudflare Tunnel); client islands hydrate against the same data on the page.

---

## 5. Page-by-page UX

### 5.1 `/` — Landing

**Purpose:** In 5 seconds of viewing, the visitor learns three things: (a) who the candidate is and what they do, (b) that this site is *itself* the proof, (c) where to click to go deeper or convert.

**Viewport 1: Hero**

```
                 ────────────────────────────────────────────

                 Jane Doe
                 Senior Software Engineer · AI Systems

                 I built this site. Everything moving on
                 this page is the agent system I designed
                 running my actual job search, right now.

                  🟢 Open to offers                  ● live

                 [  See it work →   ]   [  Talk to me →  ]

                 ────────────────────────────────────────────
```

Layout: centered, max-width 640px, vertical center on first viewport-height. The two CTAs are equal weight; the first is filled (accent), the second is outlined.

The "● live" indicator is a real-time signal:
- Connected to `/api/activity/stream`. Pulses on every received event.
- Tooltip on hover shows the latest event count and uptime.
- This single element is the visitor's first hint that this is a live system.

Below the CTAs, **a single line** that updates every page load with a real number:
> *3 active applications · last activity 4 minutes ago · cache hit rate 91%*

Source: `/api/telemetry`. The number must be honest — fewer applications is fine, "0 active applications" gets handled by showing a different message (see §10).

**Viewport 2: Funnel strip**

A horizontal 5-stage strip with the visitor's eye-line drawn left to right:

```
  Applied         Tech screen      Sys design     Final         Offer
  ●●●●            ●●               ●              –             –
  4 active        2 active         1 active                     
```

Each dot = one application. Color reflects state. Hovering shows obfuscated label ("Series-B fintech, applied 12 days ago"). Clicking the strip opens `/funnel`. No real company names on this page.

Below the strip, a single sentence:
> *Companies are obfuscated until each process closes — [see anonymization policy](/about#anonymization).*

This is itself a credibility signal (we thought about privacy, we're transparent about it).

**Viewport 3: Live activity hook**

A compact `LiveTicker` showing the most recent 5 agent events, monospace, fading older lines. The example mixes reactive (user-triggered) and proactive (cron/webhook-triggered) events — the visitor sees the system working on its own:

```
  16:42  research-company  ◆ proactive       opus-4-7
  16:39  scrape-jobs       ◆ cron (daily)    haiku
  16:35  draft-outreach    ▸ [REDACTED:ai-b] opus-4-7   (cache hit)
  16:30  briefing          ◆ proactive (am)  haiku
  16:24  parse_email       ▸ gmail webhook   haiku

  [  Watch live →  ]   ← link to /live
```

The `◆ proactive` marker calls out events the agent initiated on its own — the cleanest hint a visitor gets that this isn't a chatbot, it's an autonomous worker.

Compact, dense, monospace. This is the bridge from landing register to ops register. The visitor who clicks `Watch live →` is self-selecting into the deep view.

> **Rendering is progressive (implementation note).** The ticker renders the audit fields that actually exist on each row. As of Sub-milestone 6.1 (STRATEGY.md §24.24), `category`, `agent_name`, and the `◆ proactive` marker are live; per-event LLM telemetry (model, cache-hit, cost) is captured in a later dedicated phase and those lanes render only once populated. The ticker never shows invented data — a missing field is simply absent, not faked.

**Viewport 4: Simulator pitch**

```
                 Don't take my word for it.

                 Type your company and a role description.
                 The same agent stack that's running my job
                 search will tailor a pitch in real time.

                 [   Try the simulator →   ]
```

Big single-button CTA. No form on this viewport — the form lives on `/simulator`. Reduce friction on landing.

**Viewport 5: Resume teaser + contact**

```
  Skills              Recent work             Talk to me
  ─────               ───────────             ──────────
  TypeScript          [project 1]             ✉ jane@…
  Go                  [project 2]             telegram: …
  AI agents           [project 3]             linkedin: …
  ...                 [see all → /work]       [form → /contact]
```

Three-column on desktop, stacked on mobile. The resume content is hand-curated, kept short. The full resume lives on `/work`.

**Footer (every page):**
- Status badge (green/yellow/red, sourced from `/api/telemetry`)
- Last deploy SHA + link to GitHub repo
- Link to `/about`
- "Built with [stack list]" — small grey text

> **Build note (the funnel mouth — STRATEGY §24.30 / Sub-milestone 8.1).** The home is the mouth of the conversion funnel (§2): each viewport hands the visitor a directed next step. Phase 6.1 shipped only the hero (Viewport 1) + the live ticker (Viewport 3), so today the home channels into `/live` and leaks every other path. Sub-milestone 8.1 builds Viewport 2 (the **funnel strip**, a compact `FunnelStrip` over `/api/funnel` → `/funnel`) + Viewport 5 (the **resume+contact teaser** → `/work` + `/contact`) and rewires the hero's "Talk to me →" from its `mailto:` placeholder to `/contact`; the **simulator pitch** (Viewport 4 → `/simulator`) lands in 8.2 with that route.

---

### 5.2 `/live` — Real-time ops dashboard

**Purpose:** This is the "dig in" page. The technical visitor sees real-time, real-data, real-system signals that prove the architecture isn't smoke.

**The whole page is in ops register.** Dark, dense, monospace-leaning, multi-panel. Visitor lands and within 2 seconds sees several streams of live data updating.

**Layout (desktop, 1440+):** 4-column CSS grid, ~120px row height base unit.

```
┌─────────────────────┬─────────────────────┬─────────────────────┬─────────────────────┐
│  SYSTEM STATUS      │  ACTIVE SESSIONS    │  LLM TELEMETRY      │  CONTAINER POOL     │
│  span 1             │  span 1             │  span 1             │  span 1             │
├─────────────────────┴─────────────────────┼─────────────────────┴─────────────────────┤
│  AGENT TRACE STREAM                       │  FUNNEL (compact)                         │
│  span 2  rows 4                           │  span 2  rows 1                           │
│                                           ├─────────────────────────────────────────────┤
│                                           │  COST & CACHE                              │
│                                           │  span 2  rows 1                            │
│                                           ├─────────────────────────────────────────────┤
│                                           │  RECENT OUTCOMES                           │
│                                           │  span 2  rows 2                            │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  ANONYMIZATION DEMO  (toggle: real ↔ sanitized)                                         │
│  span 4  rows 2                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Panel: `SYSTEM STATUS`
4 stat tiles in a 2×2 mini-grid:
- `STATE`: OPEN_FOR_OFFERS / NEGOTIATING / HIRED (sourced from a SQLite key)
- `UPTIME`: from process start
- `LAST DEPLOY`: short SHA + relative time
- `BACKEND`: ONLINE / DEGRADED / OFFLINE (health check)

Each tile has a tiny sparkline of the last 24h. No legend — visitor figures it out by hovering.

#### Panel: `ACTIVE SESSIONS`
Real NanoClaw session count: live count of `container_status = running` + `idle` from the central DB. Bar chart of session counts over the past 24h.

#### Panel: `LLM TELEMETRY`
Sourced from Portkey's `/analytics/summary`:
- Cache hit rate (large number, 0–100%)
- Requests last 24h
- Median latency (p50/p95)
- Most-used model

#### Panel: `CONTAINER POOL`
Sourced from Docker via the host:
- Running containers (count)
- Idle (count)
- Memory utilization (% of `MAX_CONCURRENT_CONTAINERS * MEM_LIMIT`)

#### Panel: `AGENT TRACE STREAM` (the centerpiece)
A `LogStream` showing sanitized agent activity, live via SSE. Each line is a `TraceLine`. The example below shows a complete real-world burst: a new application triggers `research-company`, then `tailor-resume` and `draft-outreach` run **in parallel** against the research output, followed by a proactive cron-driven event:

```
16:42:11.243  research-company  ▸  opus-4-7   3,400 tok  4.2s  $0.018
                ▸ web_search("acme corp eng blog")             0.9s
                ▸ web_fetch("acme.com/engineering")            1.1s
                ▸ web_fetch("acme.com/team")                   0.8s
                ▸ tool: analyze_jd                             0.3s  cache✓
                ✓ digest produced (2.1KB)                      $0.018
16:42:11.247  ┌─ tailor-resume   ▸  opus-4-7   2,800 tok  3.4s  $0.012
              │   ▸ read_file(master_resume.md)               0.0s
              │   ▸ rank_bullets_by_jd_fit                    0.5s
              │   ▸ rewrite_top_5                             2.9s
              │   ✓ 5 bullets tailored                        $0.012
16:42:11.247  └─ draft-outreach  ▸  opus-4-7   2,100 tok  2.8s  $0.009
                  ▸ search_recipient(role=hiring_mgr)         0.6s
                  ▸ tone_match(profile=technical_warm)        0.4s
                  ▸ draft + revise                            1.8s
                  ✓ outreach draft saved                      $0.009
                                  ↑ parallel — both took 3.4s wall time
16:42:14.681  funnel.update
                ▸ [REDACTED:ai-infra-a] → STAGE_TECH_SCREEN
                  source: gmail webhook (recruiter reply)
16:42:08.119  ◆ briefing  cron  morning-summary   haiku  890 tok  0.6s  $0.001
                ▸ summarized 8 overnight events
                ▸ delivered to telegram:jane
                ✓ done
16:38:50.044  ◆ followup-nudge  cron  weekly        haiku  640 tok  0.4s  $0.001
                ▸ identified 1 stale application (12 days, no reply)
                ▸ drafted follow-up for [REDACTED:fintech-b]
                ✓ pending owner approval
...
```

The `┌─` and `└─` brackets show **parallel subagent invocation** — they share a wall-clock window and the visitor can see how concurrency saves time.

The `◆` marker tags proactive (cron/webhook-initiated) events vs reactive (user-message-initiated). Visible in the trace stream and as a filter chip.

Each `TraceLine` is collapsible: the top-level row shows agent + summary + total cost; click expands to show tool calls, subagent invocations, cache hits per step.

The stream auto-scrolls until the visitor manually scrolls up, at which point a `↓ jump to live` button appears (Slack-style).

Filter chips above the stream: `[All] [Reactive] [Proactive] [Research] [Tailor] [Outreach] [Prep] [Scrape] [System]`.

> **Backend note — trace telemetry capture.** The per-line metrics (`model_used`, `tokens`, `cost_cents`, `cache_hit`, `latency_ms`) and the `proactive` marker that powers the `◆` glyph + the Reactive/Proactive filter exist as columns on `public_audit_trail` but are not yet populated by any writer. The capture path (mirror the Agent SDK's per-turn usage from the container/poll-loop level; source `proactive` from the session trigger kind) is specified in STRATEGY.md §24.14 and built in Phase 5 alongside the SSE layer. Until then these fields render as `—` (the empty-state per §10).

#### Panel: `FUNNEL (compact)`
A reduced version of the funnel race. Same data as `/funnel` but compacted to one row.

#### Panel: `COST & CACHE`
Two numbers:
- **Today's spend:** `$X.XX` — sourced from Portkey
- **Saved via cache:** `$Y.YY` — also from Portkey (`cache_hit_count * estimated_uncached_cost`)

Tagline below: *"This page costs the candidate ~$ZZ/day to run. Cache saves the rest."*

This single signal is one of the strongest credibility moves on the site: real cost, real numbers, transparent.

#### Panel: `RECENT OUTCOMES`
A log of recent funnel state changes:
```
2026-05-25  [REDACTED:fintech-b]   APPLIED → SCREENING
2026-05-23  [REDACTED:ai-infra-a]  APPLIED
2026-05-22  Anthropic              FINAL → OFFER  ◆ public
```

Companies marked `◆ public` are ones with explicit reveal — they're displayed with their real name. See §9 for the rules.

#### Panel: `ANONYMIZATION DEMO` (the wow-finish)

A two-pane display:

```
┌─ RAW (host-side, never published)   ┬─ SANITIZED (what /live shows) ──┐
│                                     │                                  │
│  16:42  Tailored resume for Stripe  │  16:42  Tailored resume for       │
│         using JD URL                │         [REDACTED:fintech-b]      │
│         stripe.com/jobs/12345.      │         using JD URL              │
│         Recruiter Sarah B           │         using JD URL              │
│         emailed jane.r@stripe.com   │         (1 redaction)             │
│         draft saved with subject    │                                   │
│         "Re: SWE role"              │         (1 redaction)             │
└─────────────────────────────────────┴───────────────────────────────────┘

  [  Show me a real raw event  ]
```

A button below lets the visitor request a *demo* raw→sanitized transformation:
- Clicking generates a fake raw event with realistic-looking PII (synthetic, never real)
- Frontend then renders the sanitization pipeline running on it: emails replaced, phone numbers redacted, company name obfuscated
- The whole pipeline runs in <500ms and the visitor watches it work

This panel is **clearly labeled as a demo** ("Demo data, synthetic only"). It's the one place on `/live` where non-real data is allowed because the labeling makes the intent obvious.

This is also where the visitor learns that the public side of the system is genuinely privacy-aware — a meaningful credibility move with hiring managers who think about that.

> **Build note (Sub-milestone 7.3, STRATEGY §24.29).** `/live` is the aggregate dashboard, built by **composing** the pieces 7.1 + 7.2 already shipped — **zero `src/` change, purely frontend**. **Ships now:** `SYSTEM STATUS` (the `ModeBanner` mode + pause-state + a backend tile), `ACTIVE SESSIONS` (live counts), `CONTAINER POOL` (running/capacity + memory), `LLM TELEMETRY` (from `/api/telemetry`), the `AGENT TRACE STREAM` centerpiece (a fuller `LogStream` over the same SSE hook — terminal-style append, jump-to-live, filter chips on the real `proactive`/`agent_name`/`category` fields, progressive per-line metric lanes), `FUNNEL (compact)` (reusing the 7.1 components), `COST & CACHE`, and `RECENT OUTCOMES` (current-state snapshot from the funnel rows). The hero's `See it work →` CTA is rewired from its placeholder anchor to `/live`. **The telemetry-capture decision (owner-ratified):** ship every telemetry lane **honestly progressive** now, defer the capture — a per-line trace metric (`model/tokens/cost/cache/latency`) renders only when that row carries it; the Portkey-sourced `LLM TELEMETRY` + `COST & CACHE` panels populate only when `telemetry.portkey.available` is true, else show an explicit "not connected — telemetry pending" state with the reason; the always-real `local` aggregates render unconditionally. The same UI lights up with no frontend change once the per-turn usage capture (§24.14) + Portkey calibration (§24.17) land — which is why `dev:mock` (rich per-row seed + `PORTAL_MOCK_PORTKEY`) already shows the fully-populated dashboard while CI renders the honest sparse state. **Deferred:** the `ANONYMIZATION DEMO` "wow-finish" — done faithfully it should run the **real** sanitizer over synthetic input via a small `POST /api/sanitize-demo` endpoint (so it can't drift from the actual pipeline), a backend touch that belongs in its own spec'd increment rather than a frontend re-implementation bolted onto this pure-frontend page; the `ACTIVE SESSIONS` 24h history + `LLM TELEMETRY` sparklines (need a time-series endpoint); and the `(ops)` shared route-group layout (now that three ops pages exist, a clean follow-up).

---

### 5.3 `/simulator` — Recruiter Simulator

**What this is:** Proof-by-demonstration. A visiting recruiter or hiring manager doesn't have to take the candidate's word that the system works — they type in their own company name and role description, click `Run`, and watch the same agent stack that's running the candidate's real job search execute on *their* data in real time. Within 20-30 seconds they have a tangible, downloadable artifact (tailored bullets + cold outreach email).

**Three things it surfaces:**

1. **The system genuinely works.** Real LLM calls, real subagent invocations, real output streaming. Not a screencast, not a faked demo. The trace stream the visitor sees is identical to the one running on `/live` — same components, same SSE infrastructure.
2. **Engineering hygiene on display.** They see the sandbox session spin up and tear down. They see the cost reported transparently (~$0.04). They see what's *not* happening (zero DB writes, no real outreach, no Gmail/Calendar access — these tools are explicitly missing from the sandbox agent group's toolset). The labeled "DRY-SANDBOX" badge on the activity stream is itself a credibility move.
3. **Personal sales angle.** The output is tailored to *their* role, not a canned demo. They walk away with a 3-paragraph cold-email pitch and 5 resume bullets pitched at their team. The result page's `[Talk to me]` CTA pre-fills the contact form with their company name — one click from a real conversation.

**Layout:** Apple register for the input form (clean, single focal point) → switches to ops register the moment they hit `Run`. The transition is itself an "I'm not faking this" signal.

#### Input view (pre-run)

```
                 Try it on your own role.

   Company name *                Public URL (optional)
   [____________________]        [____________________]

   Role / title *
   [_____________________________________________________]

   What the role looks for (paste the JD or describe)
   [                                                     ]
   [                                                     ]
   [                                                     ]

                          [   Run simulation →   ]

                 What happens:
                 1. A sandbox container spins up in ~3s.
                 2. research-company digests your role + company.
                 3. tailor-resume + draft-outreach run in parallel.
                 4. You get a draft pitch + email in 20-30s.

                 No data persists. No DB writes. Cost ~$0.04 per run.
```

Form validation: company + role required, JD optional (if empty, we use sensible defaults).

A rate limit indicator: "8 of 10 free runs remaining today (per IP)". Limit prevents abuse.

#### Running view (the wow moment)

The moment the visitor clicks Run, the form animates up and the page switches to a 2-pane streaming view. The left pane shows live agent activity; the right pane shows output materializing as subagents finish. The orchestration runs in three phases (one serial, one parallel, then finalization):

```
t=0     visitor clicks Run
t≈3s    sandbox session ready, orchestrator picks up the inbound message
t≈3s    analyze_jd (tool) extracts role / level / skills / location
t≈4s    research-company dispatched  ────────────────┐
                                                      │ sequential
t≈12s   research digest produced (cached if rerun)   │
                                                      │
t≈12s   tailor-resume dispatched     ──┐              │
        draft-outreach dispatched    ──┴── parallel  ─┘
                                                      │
t≈20s   tailor-resume completes ─┐                    │
        draft-outreach completes ┴── streamed concurrently to right pane
                                                      │
t≈22s   orchestrator wraps up (cost summary, share URL)
t≈23s   sandbox container torn down
```

The visitor's left pane during the run:

```
┌─ ACTIVITY  ──────────────────────────────────────────────────────────┐
│                                                                       │
│  ▸ starting sandbox session...                                       │
│  ✓ session.id sb-7af3... ready                              t+1.8s   │
│  ▸ analyze_jd (tool)                              haiku    t+2.4s   │
│  ✓ jd extracted: SWE, senior, remote-ok, python+ts                   │
│  ▸ research-company invoked                       opus-4-7           │
│      ▸ web_search("<your company> engineering")                      │
│      ▸ web_fetch(3 URLs)                                             │
│      ▸ identified primary tech stack, recent launches                │
│  ✓ research-company  ─────────────────  $0.018 · 7.4s · t+11.6s     │
│  ┌─ tailor-resume   invoked            opus-4-7    [parallel]        │
│  └─ draft-outreach  invoked            opus-4-7    [parallel]        │
│  ┌─   ▸ ranking master resume bullets by JD fit                      │
│  ┌─   ▸ rewriting top 5 bullets                                      │
│  └─   ▸ searching for hiring manager / team lead                     │
│  └─   ▸ tone-matching to "technical, warm, brief"                    │
│  ┌─   ▸ drafting + revising                                          │
│  └─   ▸ drafting + revising                                          │
│  ┌─ ✓ tailor-resume complete    $0.014 · 8.1s     ◀── parallel       │
│  └─ ✓ draft-outreach complete   $0.009 · 7.8s        wall window     │
│  ✓ session complete. tearing down sandbox.                t+22.4s    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

And the right pane materializes in two columns or stacked panels, populated as each subagent finishes:

```
┌─ RESUME (5 tailored bullets, diff vs master) ────────────────────────┐
│                                                                       │
│  - Built distributed data pipelines on GCP        ◀── original       │
│  + Shipped a multi-region ingestion pipeline on   ◀── tailored for   │
│    GCP serving 4B+ events/day, the kind of scale      <your role>    │
│    your data platform team operates at.                              │
│  ...                                                                  │
└───────────────────────────────────────────────────────────────────────┘

┌─ OUTREACH (cold email draft) ────────────────────────────────────────┐
│  Subject: Engineering ICs at <your company>                          │
│                                                                       │
│  Hi <name>,                                                          │
│                                                                       │
│  I saw your team's recent post on <topic from research>...           │
│  ...                                                                  │
└───────────────────────────────────────────────────────────────────────┘
```

The right pane uses skeleton placeholders before each subagent completes, then fills in. Because tailor-resume and draft-outreach run concurrently, the visitor sees BOTH panels filling at the same wall-clock time — that's the visceral "this thing is doing multiple things at once" moment.

When the run completes:

```
  Total: ~$0.04   ·   22s elapsed   ·   1 cache hit (saved ~$0.012)   ·   sandbox torn down

  [  Download as markdown  ]   [  Share these results  ]   [  Try another  ]
                                                            [  Talk to me  ]
```

The `Share these results` action generates a unique URL `/simulator/results/<id>` that's read-only and persists for 30 days. Lets the recruiter forward it to their EM.

The `Talk to me` button pre-fills the contact form on `/contact` with the company they just simulated for.

**Build note (Sub-milestone 8.2, the conversion spine).** What ships now: the input → live 2-pane running → results flow over the Phase-5 backend (`POST /api/simulator` + the per-run SSE `trace`/`chat`/`task` stream + `GET /api/simulator/results/:id` + `/recent`); the `[Talk to me]` carries the run's company/role into `/contact` (the 8.1 sink), and a read-only `/simulator/results/$id` share page renders the 30-day cached run. **Reconciliation:** the left "ACTIVITY" pane is *not* literally `/live`'s `LogStream` — that renders flat aggregate `AuditEvent` rows with filter chips that don't apply to one run, whereas a single run's `TraceEvent` stream is shaped differently (nested tool calls under subagents via `parent_tool_use_id`, tool-vs-subagent dispatch semantics) — and is itself *leaner* than the mock above: the wire (`sdkMessageToTraceEvents`) emits only `tool`/`subagent` dispatches + one end-of-run `result` cost, so `SimActivity` shows step dispatches + a run total, not the mock's per-subagent `$·s` columns (which aren't captured). The faithful build is a trace-shaped `SimActivity` that reuses the SSE infrastructure (`SseParser` + the fetch transport) and the ops visual register; "same components" (above) means the same SSE infra + visual language, not the literal component. **Deferred:** the right pane's two-panel RESUME/OUTREACH *concurrent fill* (this section's centerpiece) needs the sandbox persona to pin a structured output format + subagent attribution on outbound rows — until then the right pane renders the streamed output faithfully (the parallelism is shown honestly in the trace pane), and `simulator_runs.outreach_draft` stays null while `tailored_resume` holds the full accumulated output; the real abuse controls on `POST /api/simulator` (Turnstile + per-IP/$-cap) are Phase-9 deploy hardening, so the rate-limit indicator is display-only for now. See STRATEGY.md §24.31.

---

### 5.4 `/funnel` — Funnel race detail

**Purpose:** The gamified deep-dive into the candidate's job search. Recruiter sees motion ("this person is in demand"), engineer sees a real pipeline tracker.

**Layout:** Ops register. The full funnel as a horse-race style horizontal board:

```
┌── APPLIED ─┐ ┌── SCREENING ─┐ ┌── TECH ─┐ ┌── FINAL ─┐ ┌── OFFER ─┐
│            │ │              │ │         │ │          │ │          │
│  fintech-b │ │  ai-infra-a  │ │  big-   │ │          │ │  Anthropic│
│  applied   │ │  screen      │ │  tech-c │ │          │ │  ◆ public │
│  12 days   │ │  3 days ago  │ │  active │ │          │ │  closed   │
│  ░░░░░░░░  │ │  ▒▒▒▒░░░░    │ │  ▓▓▓▓▒▒ │ │          │ │  ████████ │
│            │ │              │ │         │ │          │ │           │
│  ai-tools  │ │  ...         │ │         │ │          │ │           │
│  10 days   │ │              │ │         │ │          │ │           │
│            │ │              │ │         │ │          │ │           │
└────────────┘ └──────────────┘ └─────────┘ └──────────┘ └───────────┘
```

Each card is one application. Hover reveals: days in current stage, days in pipeline, last activity, obfuscated label.

Click a card → side panel opens with:
- Anonymized timeline: every state change with date
- Sanitized recent activity for that application (resume tailoring count, outreach drafted, etc.)
- A "win confidence" % (low rigor — a heuristic, labeled as such)

> **Backend note.** The richest source for "sanitized recent activity" is the funnel-curator's per-company narratives (`funnel_curator_output`, already captured privately). Surfacing them is V1-scoped but **built in Phase 6** alongside this panel and **gated on the Pass 3 LLM sanitization review** (STRATEGY.md §24.12): the narratives are free-form prose where regex + exact-name redaction isn't sufficient. Until then this panel renders from the structured `funnel_events` timeline + `public_funnel_view`.

**Reveal tier:**
- Default: obfuscated label (`[REDACTED:fintech-b]`)
- Toggle `◆ public` on an application = real company name shown + clickable to their public job listing (only set for closed or pre-public outcomes)

Above the board, four stat tiles:
- `APPLICATIONS YTD`
- `INTERVIEWS THIS MONTH`
- `OFFERS RECEIVED`
- `AVG DAYS-IN-FUNNEL` (with comparison to industry benchmark)

Footer: A short methodology block:
> *"State changes are detected from Gmail (recruiter replies, scheduling emails) and Google Calendar (interview events). All companies obfuscated by default; revealed only post-close with the company's awareness."*

> **Build note (as of STRATEGY §24.27 / Sub-milestone 7.1).** The page ships against the built `GET /api/funnel` (`public_funnel_view` + read-time `days_in_stage`/`days_in_pipeline` + `stage_counts`), read through a client-side polling hook. The board (stage columns with `motion/react` cards), the reveal tier (obfuscated label by default; real name + `◆ public` when `public_state==='public'`), the four stat tiles (derived client-side from the rows — no new endpoint), and the methodology footer all ship now. The **card detail panel** renders from the funnel-view fields available today — anonymized state/role/stage facts, days-in-stage/pipeline, the `win_confidence` % (labeled a low-rigor heuristic), and `published_learning` when present. The richer **per-application timeline** (a `funnel_events` projection endpoint) and the **funnel-curator narrative** content are deferred: the narrative stays gated on the Pass-3 LLM sanitization review (the existing backend note above); the structured timeline is its own later read-model increment. Nothing on the board is invented — optional fields render only when present (PORTAL §10).

---

### 5.5 `/architecture` — Live system map

**Purpose:** Prove the engineering. Engineers see a real running system diagram with live status.

**Layout:** Ops register. Center of viewport is the architecture diagram itself, drawn in SVG, with live status overlays:

```
                                ┌─────────────────────────────────────────┐
TRIGGERS ────────────────────►  │  HOST (Node)                            │
                                │                                          │
   Telegram (the candidate)   ──►   │  [Channel Adapters ●]                    │
   Portal sandbox (web)   ──►   │       │                                  │
   Gmail / Calendar       ──►   │       ▼                                  │
     webhooks                   │  [Router ●] ─► writes to session inbound │
   Cron sweep (60s)       ──►   │  [Sweep  ●] ─► due tasks, recurrence,   │
                                │                stale detection           │
                                │       │                                  │
                                │       ▼                                  │
                                │  [Session DB] (inbound + outbound .db)   │
                                │       │                                  │
                                ▼       ▼                                  │
                ┌───────────────────────────────────────┐                 │
                │  CONTAINER (Bun) per session          │  ◀── isolated   │
                │                                        │      per         │
                │  @anthropic-ai/claude-agent-sdk        │      session     │
                │       │                                │                  │
                │       ▼                                │                  │
                │  ORCHESTRATOR (Opus 4.7)               │                  │
                │       │                                │                  │
                │       ├─► tools (in-process):          │                  │
                │       │     analyze_jd                 │                  │
                │       │     parse_email                │                  │
                │       │     sanitize_text              │                  │
                │       │     update_application         │                  │
                │       │     record_funnel_event        │                  │
                │       │     save_outreach_draft        │                  │
                │       │     schedule_followup          │                  │
                │       │     send_message               │                  │
                │       │                                │                  │
                │       └─► subagents (read-only):       │                  │
                │             research-company           │                  │
                │             ├─ tailor-resume    ┐ par- │                  │
                │             └─ draft-outreach   ┘ allel│                  │
                │             prep-interview            │                  │
                │             scrape-jobs               │                  │
                │             │                          │                  │
                │             ▼                          │                  │
                │       [Portkey AI Gateway ●]           │                  │
                │             │                          │                  │
                │             ▼                          │                  │
                │       [Anthropic Claude API ●]         │                  │
                └────────────────────────────────────────┘                  │
                                                                            │
                                ┌───────────────────────────────────────┐  │
                                │  PUBLIC                                │  │
                                │                                        │  │
                                │  [Sanitization pipeline ●]             │  │
                                │       │                                │  │
                                │       ▼                                │  │
                                │  [public_audit_trail DB]               │  │
                                │       │                                │  │
                                │       ▼                                │  │
                                │  [Public API ●]   ─► REST + SSE        │  │
                                │       │                                │  │
                                │       ▼                                │  │
                                │  [Cloudflare Tunnel ●]                 │  │
                                │       │                                │  │
                                └───────┼────────────────────────────────┘  │
                                        ▼                                    │
                                  [Cloudflare Worker ●]  ◀── this page is   │
                                                              served from   │
                                                              here          │
                                                                            │
                                                                            ▼
                                                                       (you are here)
```

The diagram has three regions:
- **TRIGGERS** — what can wake the system: chat input from the candidate, sandbox visitors, Google Workspace webhooks, the cron sweep.
- **HOST + CONTAINER** — NanoClaw's two-process model. The host orchestrates; the container is where the agent loop runs.
- **PUBLIC** — the read-only sanitized path that feeds this very page.

Each `●` is a live status badge:
- 🟢 green = healthy
- 🟡 yellow = degraded
- 🔴 red = down
- ⚫ grey = idle / stopped

Hovering reveals current state and recent activity per node. Clicking a node opens a side panel with:
- Code links into the GitHub repo (line-anchored)
- Recent log excerpts (sanitized)
- Recent calls/events for that node

Below the diagram: a panel labeled `WHAT YOU'RE LOOKING AT`:
- Short prose explaining the architecture, pointed at engineers
- Links to the README, the per-component CLAUDE.md files, the agent definitions
- A "fork the repo" CTA

> **Build note (Sub-milestone 7.2, STRATEGY §24.28).** **Ships now:** the SVG system map (three regions, a curated faithful subset of the diagram above), a system-mode banner (`live_mode` SHADOW/LIVE + `pause_state`), per-node status badges, the node click-through side panel, and the "what you're looking at" prose+links panel — all from `GET /api/architecture` + `GET /api/system-status` via a polling hook. **The honesty rule:** a status badge lights up only for a node we actually probe (host pause-state, `backend` online, container runtime, active sessions); every other node (the external triggers, Portkey, the Anthropic API, sanitization, the tunnel/edge) renders as **structure with no health claim** — an outline marker, never a fake-green dot — with a legend stating the distinction. This is the same render-if-present discipline as the trace-telemetry lanes (§24.24). **Deferred:** live probes for the structural nodes (a Portkey health read, per-subagent activity, tunnel/worker reachability) and the per-node "recent log excerpts / recent calls" in the side panel — both need the §24.24 telemetry-capture family; until then the side panel shows the node's description + the live facts we do have + a line-anchored code link. **Enrichment (post-build):** an owner **actor** node ("Jane Doe", no status badge) with a bidirectional Telegram edge; **bidirectional** edges for the duplex relationships only (owner↔Telegram, Web-sandbox↔Router, Telegram↔Router, Router↔Session-DB) while triggers/spawns/LLM-calls/append stay one-way; and, since a technical visitor reads this page, every third-party node (Portkey, Anthropic, Telegram, Cloudflare, Google) carries a what-it-is/how-used description **plus an external doc link** even though we don't own it.

---

### 5.6 `/work` — Resume / portfolio

**Purpose:** The actual resume content. Apple register. Static-ish content.

**Sections:**
1. **Bio** — 2 paragraphs, voice-of-the candidate
2. **What I'm looking for** — short list (target roles, comp, location)
3. **Experience** — role/company/dates/3-bullet summary per role
4. **Projects** — featured projects with links (this portal itself is one of them)
5. **Writing / talks** (optional, if the candidate has any)
6. **Skills** — tag cloud (curated, not exhaustive)
7. **Education / certs** (brief)
8. **Where else to find me** — GitHub, LinkedIn, X, blog (whichever apply)

A `Download PDF` button at top + bottom — generated server-side from the structured content, NOT a static PDF. (Why: signals "I version-control my resume.")

> **Build note (as of STRATEGY §24.25 / Sub-milestone 6.2):** the page first ships as a **shell rendered against a typed `WorkProfile` placeholder** — its content lives in the private `candidate_profile` (§5.8), which is not yet populated, so the live `GET /api/profile` projection is deferred to a later increment (the placeholder shape is its contract). Optional sections (writing/talks) render only when present — no invented data. The **server-side PDF** is its own backend increment; until it lands the Download-PDF button is omitted rather than rendered dead.

---

### 5.7 `/contact` — Recruiter contact

**Purpose:** Convert. Lowest-friction submission path.

**Form:**
```
   Your name *
   [______________________]

   Email *               Company
   [____________]        [____________]

   Role / title *
   [_______________________________]

   Message *  (or paste a JD)
   [                              ]
   [                              ]
   [                              ]

                       [  Send →  ]
```

Below the form, three alternative paths:
- **Telegram** (deep link to a public bot username — replies route to the candidate via NanoClaw)
- **Email** (`mailto:` link)
- **LinkedIn**

When submitted, the message is relayed to the candidate via Telegram. Sender gets a confirmation: *"Sent. the candidate typically replies within 24 hours."*

**Spam control:** Cloudflare Turnstile captcha (invisible by default). Rate limit 5 submissions per IP per hour.

> **Build note (the conversion sink — STRATEGY §24.30 / Sub-milestone 8.1).** `/contact` is the single sink every journey path drains toward (§2), so it is pulled forward from Phase 9 into the conversion spine. It ships over the already-built `POST /api/contact` relay (`relayContactSubmission` → the owner's wired channel, e.g. Telegram — verbatim, not persisted, not sanitized, one-way, LIVE_MODE-independent) with react-hook-form + Zod (the **§3.5 Forms** choice). It reads **carried context** — typed `useSearch` `?company=&role=&from=` prefills the form (the simulator's `[Talk to me]` passes the role/company it just ran; every connective-rail convert link passes `from`) — and **relays `from` as `source`** so the owner notification shows where a lead engaged ("Came from: live"). So a convinced visitor converts in one step, not a cold form. **Submission path:** 8.1 ships the direct browser→`/api/contact` post (the relay's documented *dev* path); the **§3.5 rule #5** server-function proxy (Worker → Tunnel) + the Turnstile captcha + per-IP rate-limit (§10) are the **Phase 9 deploy** hardening — until then the relay's own validation + its deliver-only-if-a-channel-succeeded gate stand in (in dev:mock / E2E no channel is wired, so a submit honestly returns 503 → the form's "reach me directly" state).

---

### 5.8 `/about` — Methodology / FAQ

Linked from footer. Less prominent but substantive — this is where a curious engineer reading the GitHub repo lands when they want the "why" behind decisions. Covers:

- **Why this portal exists** — 1 paragraph framing
- **Anonymization policy** — the rules (see §9)
- **Credential & data privacy** — see "Two-tier vault" below
- **System modes & safety controls** — high-level explanation linking to §7
- **Cost of running this thing** — live numbers, not estimates
- **Why these specific tech choices** — NanoClaw, Claude Agent SDK, Portkey (Model Catalog), OneCLI, TanStack Start
- **How to fork it for yourself** — generic-by-design, the repo is meant to be forked
- **Honest limitations** — what this system doesn't do (anti-claims build credibility)
- **FAQ** — common recruiter questions

#### Two-tier vault (the credential story)

A subsection that calls out a deliberately strong security model — it's a credibility move with engineering visitors.

> No raw API key ever enters the agent container. Credentials are split across two purpose-built vaults:
>
> - **Portkey Model Catalog** holds the candidate's Anthropic API key as a vaulted Integration. The container makes Claude calls to `api.portkey.ai` with only a Portkey API key; Portkey looks up the right Anthropic credential, makes the actual API call, and logs the trace for observability.
> - **OneCLI Agent Vault** holds everything else — the Portkey API key itself, Google OAuth refresh tokens, Cloudflare API tokens, the Telegram bot token. OneCLI runs as a local credential-injecting proxy; the container is configured to route outbound HTTPS through it. Credentials inject at request time based on URL pattern matching + per-agent policies.
>
> The container's environment contains exactly **zero** secrets. Even if a Worker handler dumps `process.env`, nothing useful leaks. Outbound HTTPS routes through OneCLI, which knows what credential to apply for each destination and which actions require human approval.
>
> This isn't security theater — it's how Anthropic, AWS, and most enterprise AI shops manage agent credentials in 2026.

#### Content privacy (resume isn't in the repo)

A subsection that says the quiet part out loud — this repo is meant to be forked, so personal content is partitioned out:

> The career-pilot repository is **fully generic**. There is no hardcoded personal data. Three classes of content, three storage locations:
>
> | Class | Lives in | In the repo? |
> |---|---|---|
> | System code (routes, components, agent skills, sanitization rules) | `src/`, `groups/career-pilot/skills/` | ✓ public |
> | Persona content (bio, skills list, "what I'm looking for") | SQLite `candidate_profile` table, host-side | ✗ private |
> | Master resume | SQLite (private), loaded into the agent group at runtime | ✗ private |
> | Working state (applications, drafts, learnings) | SQLite (private) | ✗ private |
> | Owner config (bot token, Portkey key) | `.env` + OneCLI vault | ✗ private |
>
> A developer who forks the repo gets the system, then populates their own `candidate_profile` via the Telegram onboarding flow. None of the candidate's personal content is committed.

#### How to fork it

Short instructions for a curious engineer who wants to try it:

```
git clone <repo>
cd <repo>
bash setup.sh        # installs Node, pnpm, Docker, OneCLI, builds the container,
                     # walks Telegram pairing, runs first-agent onboarding
```

The setup script is the same NanoClaw `nanoclaw.sh` flow — fresh-machine to running agent in one command, with handoffs to Claude Code for failure recovery.

This page exists so a curious visitor never has to wonder "is any of this for real" — they can read the methodology.

---

## 6. Proactive behavior model

The portal is interesting partly because the orchestrator isn't a chatbot — it does work on its own. This section specs how that proactivity works, who initiates what, and how those events surface in the portal.

### 6.1 Actor classes

Three distinct actor classes interact with the system, each through a different surface and trust boundary:

| Actor | Surface | Agent group | Permissions |
|---|---|---|---|
| **Owner (the candidate)** | Telegram (v1); Discord later | `career-pilot` | Full. Owner role via `user_roles`. Real DB writes, Gmail/Calendar OAuth, real outreach. |
| **Sandbox visitor** (recruiter trying the simulator) | `/simulator` (web → portal channel adapter) | `career-pilot-sandbox` | Sandbox-only. No role required. Ephemeral per-visitor session. Read-only subagents; no DB-write tools; no Gmail/Calendar OAuth; separate Portkey spend budget. |
| **Contact-form visitor** | `/contact` (web POST) | (none — webhook handler) | One-way relay. No conversation. Submission is delivered to the candidate's channel as a system message. |

The owner agent group and the sandbox agent group share **skills** (the actual job-hunt logic in `groups/<group>/skills/`) but have **different container configs** — different tool allowlists, different OneCLI credential scope, different Portkey Model Catalog AI Providers (with separate spend caps). This way the sandbox can run the same `research-company`/`tailor-resume`/`draft-outreach` subagents without any risk of touching real state.

### 6.2 Proactivity taxonomy

The owner agent has three kinds of initiative, in increasing autonomy:

1. **Cron-scheduled** — recurring tasks the agent installed for itself during onboarding or via natural language ("morning briefing at 8:30am, weekday recap Friday 5pm, follow-up stale applications weekly").
   - Implemented via `process_after` + `recurrence` cron in `messages_in` (NanoClaw native).
   - The agent can list/pause/cancel its own schedules via MCP tools.
   - Visible in the portal as `◆ cron` trace events.
2. **Webhook-triggered** — external events wake the agent.
   - Gmail webhook: new recruiter reply → agent classifies (scheduling / question / rejection) → drafts response → pings owner.
   - Calendar webhook: new interview invite → updates funnel state → schedules 24h prep cron → pings owner.
   - Implemented as `messages_in` rows of `kind: 'webhook'` written by the host's Google Workspace sync module.
   - Visible in the portal as `◆ webhook` trace events.
3. **Inference-time decisions** — within a single turn, the orchestrator decides to run a subagent or take a side-effect proactively (e.g., new application detected → kick off research without being asked).
   - No special primitive; just the orchestrator's prompt + tool access.
   - Visible in the trace stream as nested subagent invocations.

### 6.3 The autonomy gradient

Not every proactive action is equal. We split the action space along a stakes axis:

| Stakes | Examples | Autonomy |
|---|---|---|
| **Read-only / internal** | Run `research-company`, update funnel state from gmail signal, draft outreach to a `drafts` table, log to `public_audit_trail` | Full autonomy. No approval. |
| **External-visible but reversible** | Update an interview prep doc, edit a draft, post to portal | Full autonomy. No approval. |
| **External-visible and irreversible** | Send real outreach email, accept a meeting time, submit a real application, withdraw from a process | **Approval required.** Agent drafts → posts a card to owner → owner clicks Approve/Edit/Reject. NanoClaw's `ask_user_question` MCP tool covers this. |
| **Spend** | Daily LLM budget thresholds | Hard cap enforced by host (refuses to wake container if exceeded). Soft cap warns owner. |

The agent's `CLAUDE.md` codifies the gradient; per-action defaults are stored in a `preferences` table the owner can edit at any time via natural language.

### 6.4 Texture controls (owner preferences)

The owner can set these via natural language on Telegram, persisted in the `preferences` table:

| Preference | Default | Notes |
|---|---|---|
| Quiet hours | 22:00–07:00 local | No proactive pings during this window unless flagged `urgent`. Reactive responses always allowed. |
| Frequency cap | Max 8 proactive pings per day | Beyond cap, agent batches into the next briefing instead of pinging. |
| Channel preference by message class | `urgent → telegram`, `briefing → telegram`, `draft-review → discord` (when wired) | Pick per category. |
| Briefing frequency | Daily 8:30 | Configurable on/off + time. |
| Auto-research threshold | New application detected | When to spend $ on `research-company` proactively. Options: never / on-trigger / on-demand-only. |
| Approval scope | All irreversible actions | The classes that require approval. Owner can promote/demote per action class. |

### 6.5 How proactivity shows up in the portal

Proactive events are first-class citizens in the public activity stream — they're the strongest "this thing actually works" signal a recruiter can see, because the system is acting on its own without a person prompting it.

In `/live` trace stream:
```
◆ briefing       cron · 08:30 daily          haiku    640 tok  $0.001
◆ followup       cron · weekly stale check   haiku    420 tok  $0.001
◆ interview-prep cron · 24h before scheduled opus-4-7 4,200 tok $0.020
◆ funnel.update  webhook · gmail recruiter   (no llm)          $0
◆ research-company auto · new application    opus-4-7 3,400 tok $0.018
```

On `/` landing ticker (compact):
```
16:30  briefing       ◆ proactive (am)   haiku
16:24  parse_email    ▸ gmail webhook    haiku
```

In `/funnel` per-application timeline:
```
2026-05-25  ◆ followup drafted (pending owner approval)
2026-05-22  ◆ funnel: APPLIED → SCREENING (gmail signal)
2026-05-18  ◆ research-company ran (initial application detected)
2026-05-18  ◆ tailor-resume ran (initial application detected)
```

The `◆` glyph is consistent across surfaces. Visitors learn its meaning quickly: "the agent did this on its own."

### 6.6 What's deliberately NOT proactive

Some things the agent never does on its own, to keep trust and avoid embarrassment:

- **Never auto-applies to a job.** Always drafts → approval → human sends.
- **Never auto-sends outreach.** Always drafts → approval card.
- **Never accepts/declines an interview slot without owner approval.**
- **Never reveals a `public_state = 'obfuscated'` company on the portal.** Reveal is owner-only.
- **Never burns through the LLM budget cap.** Hard stop, not soft warning.
- **Never speaks on the owner's behalf in any channel the owner doesn't control.**

### 6.7 Feedback loops — turning outcomes into fuel

The agent learns from outcomes. Rejection-as-fuel is the canonical case.

**Trigger:** A rejection or "we're moving forward with other candidates" email is detected in Gmail.

**Flow:**

1. Webhook → `parse_email` tool classifies the message: `rejection-after-screen`, `rejection-after-interview`, `rejection-after-final`, `ghosted` (no contact for N days after a stage).
2. Agent updates the funnel: `[REDACTED:company] → REJECTED`. A `◆ rejection` event lands in the activity stream.
3. **The reflection prompt:** Within 1 hour (or at the next quiet-hours boundary if it's late), the agent posts a card to the candidate on Telegram:
   > *"Heads up: rejection from [REDACTED:fintech-b] after the final round. Want to capture a quick reflection? 3 prompts, ~90s — feeds future runs."*
   > `[ Yes, prompt me ]  [ Later ]  [ Skip ]`
4. If accepted, the agent runs three focused prompts:
   - *"What do you think went well?"*
   - *"What didn't go well, or what would you do differently?"*
   - *"What signal do you wish you'd had earlier?"*
5. Free-form answers stored in `rejection_learnings` (private) keyed to the application + role category.
6. **Future fuel:** every subsequent `research-company` and `tailor-resume` run for similar companies/roles includes a context block:
   > *"Prior learnings from similar attempts:* [bulleted, anonymized excerpts]*"*
7. **Optional portal publication:** the candidate can flip `reflection_published: true` per learning. Published reflections show on the application's `/funnel` detail panel as a "What I learned" block, with the company still obfuscated unless `public_state = 'public'`.

**Why this matters for the showcase:** A hiring manager who lands on `/funnel` and sees a closed/rejected entry with a handwritten reflection ("*I underestimated their bar for systems design — leaning into Designing Data-Intensive Applications before my next big-tech round*") thinks: *this is someone who learns in public*. That signal is much harder to fake than competence claims.

**Other feedback loops in the same family:**

| Trigger | Reflection target | Future use |
|---|---|---|
| Interview accepted → went well | "What worked in your prep?" | Strengthens future `prep-interview` outputs |
| Outreach got a reply (positive) | "What in this draft do you think clicked?" | Reinforces voice for future `draft-outreach` |
| Outreach got a reply (negative) | "Tone? Content? Timing?" | Updates the voice constraints in CLAUDE.md |
| Offer received | "What was the unlock here?" | Captures patterns for future final-round prep |

All learnings live in the same `learnings` table with a `kind` column. Approval-gated publication, owner-only reveal.

---

## 7. System modes & safety controls

Career Pilot has weight — it touches real applications, real people, real money, and the candidate's career. Three control mechanisms keep it safe: a system-mode flag, three pause/halt tiers, and the autonomy gradient from §6.3.

### 7.1 `LIVE_MODE` — the most important switch

A single flag on the host: `LIVE_MODE: boolean` (default `false` until explicitly flipped).

**When `LIVE_MODE = false` (dry-run / shadow mode):**

| What | Still runs | Blocked |
|---|---|---|
| Telegram chat with the agent | ✓ | |
| Subagents run, drafts get generated | ✓ | |
| Real LLM calls via Portkey | ✓ (so you can profile real cost) | |
| Local DB writes (applications, drafts, funnel) | ✓ | |
| Gmail webhook triggers actions | ✓ (drafts only) | |
| Calendar webhook → updates funnel state | ✓ | |
| Portal activity stream | ✓ (clearly labeled `◇ DRY-RUN`) | |
| `send_outreach_email` (real send) | | ✗ — draft saved, never delivered |
| `submit_real_application` | | ✗ |
| `respond_to_calendar_invite` (RSVP) | | ✗ |
| Any external-visible irreversible action | | ✗ |

When `false`, the portal hero adds a small badge: `◇ SHADOW MODE — career-pilot is running in dry-run. External actions disabled.` Visitors still see the system working; recruiters might even appreciate the transparency about how cautious the rollout is.

**The flip:** the candidate promotes to `LIVE_MODE = true` via a Telegram command requiring two-step confirmation. Going back to dry-run is one command (no confirmation) — easy to back off.

This is the answer to *"I want to deploy and watch it run for a while before it can actually affect my life."* You can run for weeks in shadow mode, profile cost, watch the system make decisions you agree or disagree with, refine prompts and skills, then flip.

### 7.2 `/pause` — soft pause

Triggered by `/pause` in Telegram. Effect:
- Container completes any task in flight, then stops.
- Proactive crons are skipped (briefings, follow-ups, etc.).
- Webhook events still arrive but are queued (not dropped).
- Reactive responses to direct Telegram messages still work — pause is for proactive behavior, not your direct chat.
- Portal shows: `⏸ Paused — manual reason: <if set>` in the footer status and a small banner on `/live`.
- Resume with `/resume`. Queued webhook events fire in order.

Used for: "I'm in an interview right now, hold all pings"; "I'm thinking through a strategy change, freeze proactive behavior."

### 7.3 `/halt` — emergency hard stop

Triggered by `/halt` in Telegram or via the host's admin endpoint. Effect:
- `MAX_CONCURRENT_CONTAINERS` set to `0`; all running containers killed.
- All webhook events queue (not dropped).
- No proactive anything.
- Reactive chat disabled (Telegram bot replies: *"system halted — use `/resume` to restore"*).
- Portal goes to a graceful degraded view: cached funnel + activity, banner reads `⏸ System temporarily offline — back shortly. <optional transparent reason>`.
- Simulator disabled with a clear message: *"The orchestrator is paused for review. The simulator is back when it's back — last successful runs are still browsable below."*

Used for: cost spike, viral traffic surge, unexpected behavior I want to diagnose, anything I want to stop right now without the catastrophic-recovery overhead of killswitch.

**Recovery:** `/resume` in Telegram. Queued events drain. State self-heals.

### 7.4 `/killswitch` — catastrophic / breach

Triggered by `/killswitch` in Telegram, requires a confirmation card. Used only for: credential compromise, breach, system has done something it shouldn't have done.

Effect:
- All of `/halt`, plus:
- OneCLI agent tokens revoked → container can't make ANY authenticated outbound call even if it somehow restarts.
- Portkey rate limits flipped to 0 → even if a credential leaks, no LLM calls succeed.
- Cloudflare Worker serves a static "This system is paused for review. — the candidate" page; backend API responses replaced with 503s.
- Webhook events DROPPED, not queued. Anything in flight is lost.

**Recovery:** Requires manual intervention via SSH. Not designed for fast recovery — designed for "stop everything until I know what happened."

### 7.5 What visitors see per mode

| Host state | Portal `/` | `/live` | `/simulator` | `/contact` |
|---|---|---|---|---|
| `LIVE_MODE=true`, running | Normal | Normal | Normal | Normal |
| `LIVE_MODE=false`, running | `◇ Shadow mode` badge | `◇ DRY-RUN` on every event | Still works (sandbox isn't gated on LIVE_MODE) | Normal |
| `/pause` active | Status pill: `⏸ Paused` | Banner: `⏸ Proactive paused` | Still works | Normal |
| `/halt` active | Page: `⏸ Temporarily offline — back shortly` (cached snapshot) | Same | Disabled with clear message | Still works (doesn't depend on orchestrator) |
| `/killswitch` active | Static page: `Paused for review — the candidate` | Same | Disabled | Disabled |

The transparent "*here's why we paused*" message the candidate can set is itself a credibility move — recruiters reading *"paused due to traffic spike at 5,200 RPS — diagnosing now"* see operational maturity, not breakage.

### 7.6 The autonomy gradient still applies

Even in `LIVE_MODE=true`, the autonomy gradient from §6.3 still gates irreversible actions through approval cards. `LIVE_MODE` is the *outer* switch — gates the action *class*. The autonomy gradient is the *inner* switch — gates the specific *instance*.

Both are required for a real send: `LIVE_MODE=true` AND owner approves the specific card.

---

## 8. Cross-cutting components

### 8.1 Top nav

Minimal. Logo / wordmark left, links right:
```
  Jane Doe    /live    /simulator    /funnel    /work    /contact
```

The wordmark is the persona name, **not a domain** — the deployed site is `hire.<DOMAIN>` (`hire.example.com` placeholder) per the locked domain pattern; the earlier `janedoe.dev` here was a stray placeholder, reconciled in STRATEGY §24.25. Sticky on scroll. On mobile, collapses to hamburger.

### 8.2 Footer

Identical on every page:
```
  ───────────────────────────────────────────────────────────────────────
  Jane Doe             ● SYSTEM STATUS: ONLINE          last deploy: a3f4c1
                         · 91% cache · $0.84/day
                         
  GitHub · LinkedIn · X · /about · /privacy
  ───────────────────────────────────────────────────────────────────────
```

The status string is live (single tick per 30s). If degraded or offline, it changes color and adds a brief note.

### 8.3 Live indicator

Used on `/` and in the footer. A single small dot with `● live` label. Connects to `/api/activity/stream` and pulses on each received event. Disconnects gracefully if SSE drops.

**Resume cursor:** the stream carries a monotonic `seq` (the `public_audit_trail.seq` column) as the SSE `id:` / `Last-Event-ID`. On reconnect the client resumes with `/api/activity?since=<seq>` (or the stream's `Last-Event-ID` header). The cursor is `seq`, **not** `ts` — wall-clock timestamps tie at millisecond granularity (multiple events in one host tick), so a `since=<ts>` resume either duplicates the boundary (`>=`) or skips same-ms siblings (`>`). A monotonic integer cursor makes reconnects across the Cloudflare Tunnel idle timeout exactly-once with no gaps or dupes.

As of Sub-milestone 6.1 (STRATEGY.md §24.24) the indicator + ticker run on the audit fields that exist — `category`, `agent_name`, and the `proactive` flag (captured host-side from the triggering message kind). Per-event LLM telemetry (model / cache-hit / cost) is a later capture phase; see the §5.1 progressive-rendering note.

### 8.4 Connective rail

The directed "what's next" affordance that makes the journey (§2) physical: **no deep surface is a dead-end.** A slim band at the foot of the page content (distinct from §8.2's metadata footer) presents the contextual next steps for *this* surface — always including the convert path to `/contact`, plus 1-2 deepen/pivot options. Where the top nav (§8.1) lets a visitor jump anywhere, the rail *pulls them forward* along the path their current interest implies — the fix for the "one-shot dead-end" failure mode named in §2.

A single `ConnectiveRail` component fed a per-route config, hosted by the register layouts (the `(ops)` shared layout — finally earning its place — and the marketing layout) rather than hand-placed per page. The convert option is the constant; the rest is per-surface:

| Surface | Convert (constant) | Deepen | Pivot |
|---|---|---|---|
| `/` (home) | Talk to me → `/contact` | See it work → `/live` | Try it → `/simulator` |
| `/live` (the hub) | Talk to me → `/contact` | How it works → `/architecture` | Run it on your role → `/simulator` |
| `/architecture` | Talk to me → `/contact` | Read the code → GitHub repo | See it run → `/live` |
| `/funnel` | Talk to me → `/contact` | Watch it live → `/live` | — |
| `/work` | Talk to me → `/contact` | See the system → `/live` | — |
| `/simulator` (results) | Talk to me (context-prefilled) → `/contact` | Share results | Try another |
| `/about` | Talk to me → `/contact` | Read the code → GitHub | See it run → `/live` |
| `/contact` | — (the sink: no rail; the §5.7 alt-contact paths stand in) | — | — |

Register-aware styling: clean and spacious in the marketing register, dense and monospace in ops. The convert option carries visual primacy (accent-filled) so the path to conversion is always the most prominent next step. Every convert link routes to `/contact` with the originating surface as carried context (`?from=<surface>`); `/live`, as the hub, is the only surface that exposes all three branch directions. Reduced-motion-safe; no auto-animation.

---

## 9. Anonymization model

This is a separate, important section because it touches multiple pages and shapes the database.

### Per-application reveal state

Add a column `public_state` to the `applications` table:
| value | meaning |
|---|---|
| `obfuscated` (default) | Shown as `[REDACTED:<category>-<n>]` (e.g. `[REDACTED:fintech-b]`) |
| `partial` | Category and stage shown; company name still redacted |
| `public` | Real company name shown |

the candidate toggles this per application via Telegram (`@career-pilot reveal stripe`) or via an admin route. **Default is `obfuscated` until explicitly toggled.**

### Rules

1. **Active applications are obfuscated by default.** Real names only after explicit flip.
2. **Closed-with-offer / hired:** Public by default IF the company has agreed (the candidate confirms).
3. **Closed-rejected / withdrawn:** Stays obfuscated unless the candidate chooses to publish (e.g. "Big Tech Co rejected me at the final round, here's what I learned" — only if they want that publicly).
4. **No PII anywhere ever.** Recruiter names, email addresses, phone numbers, scheduling links — all redacted by deterministic regex BEFORE LLM sanitization. The LLM sanitization is a second pass for context-dependent leaks.

### Sanitization pipeline (host-side)

Every event flowing to `public_audit_trail` runs through:
1. **Deterministic regex pass:** emails, phones, URLs containing recruiter names, monetary amounts, addresses.
2. **Company name pass:** every application's `company_name` (and `aliases` array) gets replaced with its current `obfuscated_label` (e.g. `[REDACTED:fintech-b]`) or its real name if `public_state = 'public'`.
3. **LLM context-sensitivity pass (optional, async):** Haiku reviews the sanitized text for leak risk; if flagged, escalates to the candidate for approval before publication.

Failed sanitization = event dropped, NOT published. Better to lose an event than leak PII.

### Public/private partitioning

Backend tables:
- `applications`, `learnings`, `job_leads`, `candidate_profile` (private, host-only — never served)
- `public_audit_trail` (sanitized event log, served to portal)
- `public_funnel_view` (sanitized current-state projection of applications, served to portal)

**The invariant:** the portal API `SELECT`s only from `public_audit_trail` + `public_funnel_view`. It never touches a private table. The portal Cloudflare Worker has no path to private data. This is enforced by *structure*, not per-query discipline — both public tables are populated by host-side maintenance hooks that run the sanitizer before writing, so any row the API can read is already safe.

#### `public_funnel_view` — the current-state read-model

`public_audit_trail` is an append-only *event log*; the funnel surfaces (`/` strip, `/funnel` board, `/live` compact funnel) need *current state per application*. `public_funnel_view` is a maintained physical projection table (one row per application), written by a host-side hook on every `applications` / `funnel_events` write — the same best-effort, post-commit discipline as the `public_audit_trail` mirror. Columns:

| Column | Meaning |
|---|---|
| `application_id` | PK (links back to the private row, host-side only) |
| `application_ref` | `obfuscated_label`, OR real `company_name` when `public_state = 'public'` |
| `public_state` | `obfuscated` / `partial` / `public` |
| `role_title`, `status` | current canonical status (see the pinned status vocabulary) |
| `stage` | the derived 5-stage value for the funnel strip (Applied / Screening / Tech / Final / Offer, + terminal) |
| `applied_at`, `stage_entered_at`, `last_activity_at` | timestamps — the API/frontend computes "days in stage / pipeline" at read time (never precomputed, so a row never goes stale) |
| `win_confidence` | heuristic %, labeled low-rigor on `/funnel` |
| `published_learning` | sanitized excerpt of the latest published reflection for this application (nullable) — feeds the `/funnel` "What I learned" block (§6.7) without the API ever reading the private `learnings` table |

When an application's obfuscation policy changes (`public_state` flip, label/name edit), the hook refreshes the row so `application_ref` reflects current intent — mirroring the retroactive resanitization already done for `public_audit_trail`.

---

## 10. Empty / edge / failure states

| State | Behavior |
|---|---|
| **System is in early days, 0 active applications** | Landing hero shows: "Career Pilot just launched. The first agents are warming up — check back in a few days." Funnel strip shows a friendly empty state. `/live` shows the system architecture and a "no agent activity yet" message instead of the trace stream. |
| **Hired** | Hero replaces with: "🏆 Hired by [company]" (if public) or "🏆 Target secured" (if private). Funnel locks. Simulator stays open. Contact form replaced with "I'm not actively interviewing anymore — but for future opportunities, here's how to reach me." |
| **Backend down** | Portal falls back to static cached snapshot (Cloudflare Worker serves a stale build). Footer status shows red. `/live` shows "system offline" with last-known timestamp. Simulator disabled with: "The orchestrator is offline; come back in a few minutes." |
| **Portkey down** | Telemetry tiles show "—" instead of numbers. Activity stream continues from local DB. No degradation of essential functions. |
| **Simulator hit rate limit** | Show clear message + reset time. Offer the contact form instead. |
| **Sanitization failed** | Event dropped silently. Logged to host-side admin Telegram for review. Portal continues. |
| **JS disabled** | Static rendered hero + funnel snapshot + contact form work. No live ticker, no simulator. |

---

## 11. Backend surfaces required (bridge to STRATEGY.md)

To support this portal, the backend must expose:

| Surface | Source | Cardinality | Latency budget |
|---|---|---|---|
| `GET /api/funnel` | `public_funnel_view` (sanitized projection; never reads `applications` directly — see §9) | ~10-50 rows | <100ms |
| `GET /api/activity?since=<seq>&limit=50` | `public_audit_trail` (cursor = monotonic `seq`, not `ts`; see §8.3) | up to 50 events | <100ms |
| `GET /api/activity/stream` | SSE; tails new `public_audit_trail` rows; emits `seq` as `id:` for resume | streaming | first event <500ms |
| `GET /api/telemetry` | Portkey `/analytics/summary` + local aggregates | 1 record | <500ms (cache 30s) |
| `GET /api/architecture` | NanoClaw central DB + Docker status | 1 record | <300ms |
| `POST /api/simulator` | Spawns sandbox session in `career-pilot-sandbox` agent group | 1 session | <3s to ready |
| `GET /api/simulator/:id/stream` | SSE tailing the sandbox session's messages_out | streaming | first event <2s |
| `GET /api/simulator/results/:id` | Persisted simulator output (30d TTL) | 1 record | <100ms |
| `POST /api/contact` | Relays to the candidate's Telegram via NanoClaw | 1 message | <2s |

Backend-side capabilities required:
- **A `portal` channel adapter** for NanoClaw so simulator runs are first-class NanoClaw sessions.
- **A read-only observer module** that tails session DBs and writes sanitized rows to `public_audit_trail`.
- **A Portkey analytics proxy** that caches Portkey responses for 30s to avoid hitting their API on every page load.
- **A sanitization pipeline** as described in §9.
- **Rate limiting** on `/api/simulator` (per IP) and `/api/contact` (per IP + spam control).

Detailed in `STRATEGY.md` (to be written next).

---

## 12. Content variables (TBD inputs from the candidate)

Things the candidate needs to provide before the portal can ship — **but the system ships without them**. See "Placeholder strategy" below for how.

| Variable | Where it goes | Provided by |
|---|---|---|
| Bio paragraphs (2 short paragraphs) | `/work` hero + meta description | Owner |
| Headshot (optional) | `/work` and meta og:image | Owner |
| Master resume markdown | SQLite `candidate_profile.master_resume` (private, never in repo) — used by `tailor-resume` agent and rendered on `/work` | Owner via Telegram onboarding |
| Featured projects | `/work` and `/` viewport 5 | Owner (could come from a GitHub API call as a default) |
| Curated skills list | `/work`, `/` | Owner |
| Writing/talks (optional) | `/work` if present | Owner |
| Public Telegram bot username | `/contact` deep link | Owner (separate bot from admin bot) |
| Real social URLs (GitHub/LinkedIn/X) | Footer + `/work` | Owner via env or DB |
| "What I'm looking for" statement | `/work`, `/` hero copy | Owner |
| "Why this exists" prose | `/about` | Owner |
| Brand color (accent) | Tailwind theme tokens | Owner (defaults to neon green/cyan from §3) |

### Placeholder strategy

The portal **must** ship and run without all of these populated. The user (the candidate) should be able to deploy on day 1 with everything empty and see the system running end-to-end with placeholder content, then refine variables one at a time over time.

**Default behavior for each unset variable:**

- **Render with a clearly-marked placeholder** — e.g. `[bio: 2 paragraphs describing yourself and your work]` in the position the real content would go.
- **In public-mode (default for non-owner visitors):** placeholders are styled subtly (slightly muted, italicized) so the portal still looks intentional. The visitor sees that the system is alive but some content is still being filled in. This is honest and recruiters will read it as a "WIP launching in public" signal, which is actually charming.
- **In owner-mode (`?admin=true` or recognized admin session):** placeholders are highlighted with a bright outline and a one-click "Fill this in via Telegram" button that opens the bot with the right prompt.

**Owner experience for populating variables:**

the candidate can fill these in natural-language via Telegram at any time. Examples:
- *"My bio is two paragraphs — first paragraph: ..."* → agent updates `candidate_profile.bio`
- *"Set the accent color to ..."* → agent updates the Tailwind theme override
- *"Here's my master resume:"* (paste or attach file) → agent updates `candidate_profile.master_resume`

The agent uses the `update_profile_field` MCP tool, validates the input, writes to the DB, and the portal picks up the change on next request (no rebuild needed for content variables).

**What's the minimum to flip `LIVE_MODE = true`?**

A short opinionated checklist the portal surfaces to the owner:

```
Ready to go live? (5/11 complete)
  ✓ Bio
  ✓ Master resume (used by agents)
  ✓ Social URLs (GitHub minimum)
  ✓ "What I'm looking for"
  ✓ Public Telegram bot configured
  ○ Featured projects (recommended but not required)
  ○ Headshot (recommended but not required)
  ○ "Why this exists" prose for /about
  ○ Curated skills list
  ○ Writing/talks
  ○ Brand color (using defaults)

The required 5 are filled in. You're ready for LIVE_MODE.
```

The required 5 are enforced (the `LIVE_MODE` flip command refuses if they're not set). The rest are nice-to-haves.

---

## 13. Open questions

1. **Should `/live` be discoverable without clicking through?** Alternative: render a "preview pane" of `/live` as a viewport on `/` for visitors who don't click. Risk: dilutes the apple-clean hero. Recommendation: keep landing clean, but add a single ~120px-tall live ticker between viewports 2 and 3 as a teaser.

2. **Anonymization for hired companies that haven't agreed:** What's the policy if the candidate signs an offer with a company that wants to keep the hire quiet for now? Recommendation: default `public_state = 'partial'` for any offer/hire until explicit reveal.

3. **Recruiter Simulator scope:** Do we run `resume-tailor` only, or `resume-tailor + outreach-drafter` (full pitch)? Two skills × ~$0.04/run vs one × ~$0.02. Recommendation: full pitch — that's the wow moment.

4. **Cost cap on simulator:** A pessimistic max of $5/day in simulator spend (≈100 runs) feels right. Above that, simulator goes read-only with a "back tomorrow" message. Confirm.

5. **PDF resume generation:** Server-side generation (puppeteer in the host process) or static commit-time artifact? Recommendation: server-side, signals "live system."

6. **Mobile experience for `/live`:** Dense ops UI doesn't translate. Options: (a) hide non-essential panels on mobile and show a vertically-stacked subset, (b) render `/live` as a horizontal carousel of panels, (c) redirect mobile to `/` with a "best on desktop" note. Recommendation: (a) — vertically stacked subset.

7. **Anonymous analytics for the portal:** Cloudflare Web Analytics or none? Recommendation: Cloudflare, since it's privacy-respecting and free with the Workers deployment.

8. **Accessibility:** WCAG AA target. The dense ops register needs careful attention to contrast ratios + ARIA labels for the live stream + keyboard navigation through filter chips. Recommendation: explicit pass during implementation; not a blocker for v1.

---

## 14. Out of scope (deliberately)

- A blog / writing CMS — link out to wherever the candidate writes.
- A general portfolio (non-career-pilot) — `/work` covers the resume case, but career-pilot is the centerpiece.
- Multi-user / SaaS-ifying career-pilot. The portal showcases a single user. If a recruiter wants the same for their candidate pool, that's a future product, not v1.
- Internationalization. English only.
- Dark/light mode toggle. Dark only.
- A "live chat with the agent" experience for visitors. The simulator covers this with bounded scope.

---

## 15. Next step

After sign-off on this spec, the next deliverable is `STRATEGY.md`:
- Branch structure (where this lives relative to NanoClaw fork)
- Backend module layout (portal module, sanitization, public_audit_trail, sandbox agent group, portal channel adapter)
- Career-pilot agent group definition (CLAUDE.md, skills, subagent design via Claude Agent SDK `agents:` option)
- Portkey + OneCLI credential layout
- Infrastructure (GCP e2-medium, Cloudflare, deploy paths)
- Milestone plan from "fork NanoClaw" to "portal live with real data"
