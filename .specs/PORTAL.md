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

- **The home is the funnel mouth.** Its five viewports (§5.1) *are* connective tissue: each hands off a directed next step (funnel strip → `/pipeline`, live ticker → `/live`, simulator pitch → `/simulator`, resume teaser → `/work` + `/contact`). A fully-built home channels; a hero-only home leaks.
- **`/live` is the hub.** It's where the one register-crossing CTA lands (§3.5) and where intent forks: the skeptic deepens into `/architecture` + the repo, the "prove-it" visitor pivots to `/simulator`, the convinced visitor converts at `/contact`.
- **`/contact` is the single sink.** Every surface offers a path to it, and it accepts **carried context** (the role/company a simulator run was about, the surface the visitor came from) so converting is one low-friction step, not a cold form.
- **Every deep surface offers a next step.** No `/live`, `/pipeline`, `/architecture`, `/simulator`, or `/work` is a terminus: each carries the **connective rail** (§8.4) — a constant convert path (→ `/contact`) plus 1-2 contextual deepen/pivot options. The top nav (§8.1) independently supports free "bounce anywhere" movement; the rail adds *directed* pull so an interested visitor is led forward rather than left to find their own way.

This journey is not new scope invented here — it's the persona paths above + the §3.5 register transitions made physical. What it adds is the **connective tissue**: the rail (§8.4), the home build-out (§5.1), and a real `/contact` sink (§5.7) — turning five strong-but-isolated surfaces into a path that deepens and converts. STRATEGY.md §24.30 carries the delivery decomposition (the "conversion spine").

---

## 3. Style guide — "Apple hero, Bloomberg gut"

The portal is visually split between two registers:

### A. Landing register: Apple/Linear cleanness
Used on `/`, `/work`, `/contact`. Generous whitespace, large typography, restrained color, one focal element per viewport-height. Conveys product taste; doesn't intimidate the non-technical visitor.

### B. Operations register: Bloomberg/mission-control density
Used on `/live`, `/pipeline`, `/architecture`. Dense multi-panel layouts, monospace numeric data, streaming text, abundant real-time signals. Conveys engineering depth; rewards visitors who clicked "see it work."

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
| `FunnelStrip` | Both | Compact 5-stage strip on `/`, full-detail board on `/pipeline` |
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

- **Type-safe routing end-to-end.** Every route param, search param, loader return, and `<Link>` target is inferred by the compiler. Critical for our dashboard pages with multi-param state: `/live?filter=tailor&since=<ts>`, `/pipeline?reveal=fintech-b`, `/simulator/results/:id`. Rename a route → TS catches every call site.
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
6. **Search params as first-class state.** Filter chips on `/live`, reveal toggles on `/pipeline`, and pagination on `/simulator/results` use TanStack Router's typed `useSearch()` instead of ad-hoc URL parsing — deep-linkable, type-safe, refresh-safe.
7. **Reduced-motion is a structural guarantee, not per-component discipline** (STRATEGY §24.36 36.4). Two animation systems, two complementary mechanisms: a global `@media (prefers-reduced-motion: reduce)` reset in `app.css` neutralizes looping/decorative CSS *animations* + smooth-scroll (skeletons' `animate-pulse`, the stream `LiveCursor`, the ●live dot, any future one — scoped to animations, not a blanket transition reset, which is the standard interpretation), and a single root `MotionConfig reducedMotion="user"` makes *all* motion/react animations (the grow-modal, the funnel card layout) respect it — so neither system can regress a new animation past the guarantee.
8. **Two stream-reconnect models, both deliberate.** The activity stream reconnects (`connecting → open → reconnecting`, exponential backoff, resume via `?since=<lastSeq>`) — surfaced by `LiveIndicator` (the dot pulses only while `open`) + the trace/ticker connecting/empty/offline states. The **simulator** stream does *not* reconnect — a torn-down sandbox can't resume mid-run, so a drop ends the run (`SimFallback`). Correct difference in lifecycle, not an inconsistency.

**Implementation discipline:** Before any frontend code lands, we do a focused TanStack Start docs pass (v1 changelog, the `@cloudflare/vite-plugin` deploy path, server-functions API, search-param typing patterns) and capture canonical patterns for our specific needs (SSE streaming, server-function error handling, route prefetching). Done — captured in STRATEGY.md §24.23.

**Alternative considered:** Next.js 15 App Router on `@opennextjs/cloudflare`. It's the safer/universally-recognized pick — production-locked, larger community, more recipes for SSE-on-Workers patterns. We're trading some of that recognition for type-safety wins, smaller bundles, and the taste signal. If TanStack Start ever feels like it's costing us more than it's giving us, the fallback is a one-day port.

---

## 4. Site map

```
/                    Landing — hero + funnel + activity hook + simulator CTA
/live                Real-time ops dashboard (the "dig in")
/simulator           Recruiter Simulator (interactive sandbox)
/pipeline            Funnel race detail + history + outcomes (visitor label "Job Pipeline"; internal name = funnel)
/architecture        Live system architecture + current state
/work                Resume / experience / projects / writing
/contact             Recruiter contact form + direct contact options
/about               Why this exists, methodology, FAQ (footer link only)
/kit                 Interview-kit dossier (?app=«ref»&round=«round»; linked from the /pipeline drawer)

API routes (consumed by the frontend)
/api/funnel          GET — sanitized funnel state
/api/kit             GET — one kit's public projection (?app=«ref»&round=«ROUND»; sealed sections carry counts, never text)
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
                 Senior Software Engineer · Team Lead

                 I built an AI agent system that runs my
                 job search — and this entire page is it,
                 working live.

                       ( ● Open to offers )

                 [  See it work →   ]   [  Talk to me →  ]

                 ────────────────────────────────────────────
```

Layout: centered, max-width 640px, vertical center on first viewport-height. The two CTAs are equal weight; the first is filled (accent), the second is outlined.

A single **"Open to offers" availability badge** (`hero-status`) — a bordered pill with a brand-green dot that **pulses while the live feed (`/api/activity/stream`) is connected** and falls still if it drops. "Open to offers" is the signal a recruiter actually wants; the pulse is the page's own liveness cue, and the tooltip shows the received-event count. It is the visitor's first hint that this is a live system.

> **Build note (the `/` polish pass).** This badge replaces the original two competing elements — a literal `🟢` emoji "Open to offers" beside a separate "● live" word (the only emoji on a site with an otherwise custom dot/glyph vocabulary). Unified into one on-brand pill: the SSE liveness is folded into the dot's pulse rather than spelled out a second time, so the badge leads with the availability signal. Same pass:
> - **Stat-line stability** — the **whole line is SSR-seeded** (`getHeroSeed` fetches `/api/funnel` + `/api/telemetry` server-side, the same tunnel + Access path as `getWorkProfile`), so it's in the first-paint HTML instead of popping in from a skeleton. The counts come from the funnel + telemetry; **"last activity X ago"** is computed server-side from a new `/api/telemetry` field — **`local.last_activity_at`** (the latest NON-turn audit ts, matching the ticker, which excludes `turn` rows). The relative string is the hard SSR case (server vs client `now`), so the client renders the **seed string verbatim** until the live stream supplies the **same** latest event after mount — no recompute on the first render → no hydration mismatch, and because seed and stream point at the same event, the takeover doesn't move the line. A fixed-height slot (1 line desktop / 2 lines mobile) + the skeleton cover only the rare empty-seed case (backend unreachable at SSR). (Superseded two earlier tries: the skeleton+min-height nudged on the segment fill; SSR-ing only the counts left "last activity" popping in and shifting the centered line — the whole line had to seed.)
> - **Width parity** — the funnel + the activity ticker share one width (both `max-w-3xl`).
> - **The pitch-beat steps** became one centered row of brand-tinted number chips; the **simulator CTA** stopped echoing its own heading ("Run it on your role →").
> - **"live" used sparingly** — the word was diluting the hook by repetition, so it's kept only at the hook ("working live") and the funnel ("My job search, live"); the ticker is **"Agent activity"** (was "Live activity"), its link **"see it all →"** (was "watch live →"), the funnel link **"track it →"**, and the simulator "runs **right** in your browser" (was "live").
> - **Simulator honesty** — the deliverable line now names **both** artifacts ("hands you both the tailored résumé and the cold-email draft"), and "Nothing gets **sent or** submitted anywhere" covers the draft too.
> - **Connective rail (§8.4)** — centers its wrapped buttons on a phone (the 2+1 wrap read as ragged left-aligned overflow); unchanged inline-left from `sm` up.
>
> Visual baselines re-blessed at the end of the pass.

> **Build note (per STRATEGY §24.57).** The indicator's hover `title` shows the event count; **uptime is not captured anywhere** and is dropped from the promise (an invented number would violate the honesty rule). Ticker time legibility: a line from a previous local day renders `«Mon D» HH:MM` in the clock slot (today's lines keep `HH:MM:SS`) — same width class, mobile-safe.

Below the CTAs, **a single line of real, live numbers** (continuously updated, not just per page load):
> *3 active applications · 47 agent actions in 24h · last activity 4 minutes ago*

Sources: the funnel (`/api/funnel`, active = in-flight), telemetry (`/api/telemetry` → `activity_events_24h`), and the activity stream (latest event) — the same live hooks already on the home. Each segment must be honest and is **omitted when its number is empty** (never faked or zero-padded); "0 active applications" gets a different message (see §10).

> **Build note (§24.71 hero audit).** Two changes land here. (1) The spec's third stat was "cache hit rate 91%" — dropped: it's LLM prompt-cache jargon that reads as cryptic on a first impression. `activity_events_24h` ("agent actions in 24h") replaces it — same "working right now" signal, plain language. The honest line is built by the pure, tested `heroStats()` helper (omit-when-empty) and reserves a line of height so populating it doesn't shove the hero (§24.36). (2) The hook is reordered to **orient before it proves** — it leads with *what this is* ("I built an AI agent system that runs my job search") before the live indicator, stat line, and funnel corroborate it — killing the "what am I looking at?" landing. The hook bolds **AI agent system** (the one emphasized phrase) as the single differentiator. Hero positioning is "Senior Software Engineer · Team Lead" — deliberately generalist (no pinned specialty: the candidate reads as someone who ships across the stack), and it avoids repeating "AI agent system", which the hook already carries.

**Viewport 1.5: The pitch (plain English) — STRATEGY §24.75**

The hero *hooks*; the live viewports below *prove*. Between them sat a gap — the site was show-rich and tell-poor, so a visitor had to reverse-engineer what the system actually does and why it's worth caring about. This beat closes it: a compact, value-first narrative in the candidate's own voice, the one place the whole thing is *explained* before the evidence arrives.

```
                 The job hunt is a grind: find the roles, research
                 each company, tailor your résumé, write the outreach,
                 prep for the interview — then do it again, a hundred times.

                 So I built an AI agent system that runs that loop for me,
                 continuously, and keeps me in the driver's seat.
                 This whole page is that system, working live.

                   1 · finds roles      2 · tailors my materials to each
                   3 · drafts outreach   4 · builds interview prep

                 …and you can watch it happen, or run it on your own
                 open role right now.

                                              Read the full story →   (/about)
```

Marketing register, calm prose, `max-w-prose`. Candidate's-POV, **value-first** — what the system does and why it's a smart way to run a real search, in plain language, before any live data appears. It is static prose (no per-visitor data; the name/voice come from the SSR'd `candidate_profile` identity, like the hero). It ends with **one quiet, ignorable deepener** — "Read the full story →" → `/about` (the story-first depth page, §5.8) — for the visitor who wants the long version; everyone else scrolls straight into the proof below. This is the *only* path to the long-form story besides the footer's "About" link — the page is deliberately **not** in the header (§8.1: header = the journey, footer/depth = background). The less-interested visitor is never dead-ended by it.

**Viewport 2: Funnel strip**

A horizontal 5-stage strip with the visitor's eye-line drawn left to right:

```
  Applied         Tech screen      Sys design     Final         Offer
  ●●●●            ●●               ●              –             –
  4 active        2 active         1 active                     
```

Each dot = one application. Color reflects state. Hovering shows obfuscated label ("Series-B fintech, applied 12 days ago"). Clicking the strip opens `/pipeline`. No real company names on this page.

Below the strip, a single sentence:
> *Companies are obfuscated until each process closes — [see anonymization policy](/about#anonymization).*

This is itself a credibility signal (we thought about privacy, we're transparent about it).

> **Build note (dimensional stability, STRATEGY §24.36).** Several home-viewport elements were brought into the §24.36 "hold the shape from first paint" standard. (1) **Viewport 1's `live` indicator** has a fixed total width (dot + the longest status, `reconnecting` = 12ch in the mono font) with the dot+label **centered** inside it, so it never resizes as the SSE status flips `connecting → live → reconnecting` (no nudging the centered hero row or the header it sits in). A fixed-width slot for a variable label trades a hair of centering for zero motion (the visible content sits ~14px left of true centre in the steady `live` state — the owner's chosen trade-off over a one-time settle; pixel-perfect centering would require equal-length status words or dropping the word). (2) **The funnel strip (Viewport 2)** renders from first paint with a `FunnelCompact` skeleton while the first `/api/funnel` poll is in flight, instead of being gated `apps.length > 0` (which popped the whole strip into existence and shoved the page once data arrived — there's essentially always live data here). A cold backend error is the one case the strip collapses (no point stranding a forever-skeleton). (3) **The Viewport 3 `LiveTicker`** reserves its 5-row feed capacity (`min-h-[7.25rem]`) so the connecting/empty message and the populated list occupy the same height — the box no longer grows when events arrive.

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

> **Build note (STRATEGY §24.35 Pass A).** The ticker's `watch live →` link to `/live` (mockup above) was specified but unbuilt through 8.x — the shipped `LiveTicker` rendered no link, dead-ending Viewport 3 (the only path on was the top nav). §24.35 Pass A builds it as a page-supplied `<Link>` via an optional header slot (the component stays router-free), and adds the analogous `/live` FUNNEL-panel → `/pipeline` link.

> **Build note (STRATEGY §24.35 Pass C).** The compact ticker **drops `category='turn'` rows** — those per-turn cost summaries (§24.34) are the `/live` trace stream's story (where they render as a batch-sealing separator); on a 5-line teaser they're noise. The ticker shows the action events; the turn-cost rollup lives on `/live`.
>
> **Refinement (STRATEGY §24.45).** The drop now happens at the *stream-hook ingestion* (the `exclude:['turn']` option), **before** the 5-row cap — not only in the component. Filtering after the cap meant a turn-heavy stretch (common once the §24.44 dev model-tier runs Haiku, which delegates less) could fill all five kept rows with turns and blank the ticker even while real actions sat just behind them. Excluding at ingestion makes the window hold the last five *actions*. The component still drops turns defensively.

> **Rendering is progressive (implementation note).** The ticker renders the audit fields that actually exist on each row. As of Sub-milestone 6.1 (STRATEGY.md §24.24), `category`, `agent_name`, and the `◆ proactive` marker are live. LLM telemetry (model, tokens, cost, cache-hit, latency) lands in STRATEGY.md §24.34 — captured **per-turn** (the SDK only resolves cost per `query()`-call, never per-event), so a dedicated `category='turn'` summary row carries those lanes populated, while funnel/progress rows leave them absent. The ticker never shows invented data — a missing field is simply absent, not faked, and a per-event cost split (which the SDK can't derive) is never fabricated.

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

> **Build note (the funnel mouth — STRATEGY §24.30 / Sub-milestone 8.1).** The home is the mouth of the conversion funnel (§2): each viewport hands the visitor a directed next step. Phase 6.1 shipped only the hero (Viewport 1) + the live ticker (Viewport 3), so today the home channels into `/live` and leaks every other path. Sub-milestone 8.1 builds Viewport 2 (the **funnel strip**, a compact `FunnelStrip` over `/api/funnel` → `/pipeline`) + Viewport 5 (the **resume+contact teaser** → `/work` + `/contact`) and rewires the hero's "Talk to me →" from its `mailto:` placeholder to `/contact`; the **simulator pitch** (Viewport 4 → `/simulator`) lands in 8.2 with that route.

---

### 5.2 `/live` — Real-time ops dashboard

> **Source-label aliasing (owner call, 2026-06-03; vocabulary updated per STRATEGY §24.59, 2026-06-10).** The activity feed (ticker + trace) shows each event's source — `agent_name`, else `category`. Historical audit rows keep internal ids containing "funnel" (`category='funnel'`, `agent_name='funnel-curator'` — the subagent's pre-rename name); they're **aliased for display** to `pipeline` / `pipeline-scribe` so nothing reads "funnel" on the public surface (the §8.1 rule). New rows carry `agent_name='pipeline-scribe'` natively. Surface-only for the category: the audit vocabulary keys stay internal; the filter chips match on id *lists* (old + new ids → one chip).

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

> **Superseded (STRATEGY §24.57).** Per-step expansion needs per-event cost/tool detail the SDK does not expose (§24.34 deferred the per-event enrichment for exactly this reason) — a collapsible row with nothing real behind it would be interaction theater. The turn-level story lives on the **seal's InfoTip** instead; revisit only if §24.34's deferred enrichment lands. What DID land from the §24.57 pass: **day-boundary divider rows** (chat-app style, plus a leading divider when the window opens on a non-today date — the realistic-pace window spans days) and **InfoTip explainers** (tap/hover/focus disclosures, mobile-first) on the metric jargon: `spend · est`, the cache-rate line, `turn p50/p95`, the turn seal.

The stream auto-scrolls until the visitor manually scrolls up, at which point a `↓ jump to live` button appears (Slack-style).

Filter chips above the stream: `[All] [Reactive] [Proactive] [Research] [Tailor] [Outreach] [Prep] [Scrape] [Scribe] [System]`.

> **Build note (STRATEGY §24.60 — interactivity pass 2).** Three trace-stream additions: (1) a rendered `[«application_ref»]` on a trace line (and on the home ticker's rows) is a **deep-link** into that application's `/pipeline` drawer — dotted underline as the touch-visible affordance; (2) the header carries a single **"the cast" InfoTip** — one ⓘ listing the six subagents with one-line roles plus what an unlabeled row is (the orchestrator) — chosen over per-occurrence name tips, which were rejected as clutter; (3) the stream accepts **`/live?app=«ref»`** (the drawer's "Live activity →" link lands here): a dismissible `[«ref»] ×` chip AND-composes with the agent chips, filtering to that application's rows **within the live window only** — it is not an archival query, and the no-match state says so. The per-application timeline endpoint stays deferred (§24.27).

> **Backend note — trace telemetry capture (updated per STRATEGY §24.34/§24.55).** The per-line metrics are captured per-*turn* (a `category='turn'` seal row carrying model / tokens / cost / cache / latency — the SDK resolves cost only per `query()` call), populated for **every** owner turn (§24.55 lifted the original portal-worthy gate). Cache state renders quantitatively — `cache NN%` from `cache_read_pct` (share of prompt tokens served from cache) — never as a boolean badge (an agent turn virtually always reads *some* cache, so `cache✓` carried no information). Action rows keep their progressive lanes (render-if-present).

#### Panel: `FUNNEL (compact)`
A reduced version of the funnel race. Same data as `/pipeline` but compacted to one row.

#### Panel: `COST & CACHE`
Two numbers:
- **Today's spend:** `$X.XX` — sourced from Portkey
- **Saved via cache:** `$Y.YY` — also from Portkey (`cache_hit_count * estimated_uncached_cost`)

Tagline below: *"This page costs the candidate ~$ZZ/day to run. Cache saves the rest."*

This single signal is one of the strongest credibility moves on the site: real cost, real numbers, transparent.

> **Build note (per STRATEGY §24.47/§24.55).** Portkey's analytics API is Enterprise-only, so the shipped panel is sourced from **local per-turn capture** instead: the headline is the lifetime **combined** estimate (agent turns + simulator runs, both SDK estimates labeled "est"), the sub-line is the cache-read share of prompt tokens, and the windowed bottom line breaks today down (`$A today · agent $B · sim $C`). The "saved via cache" dollar figure and tagline were dropped — a derived counterfactual, not a captured number. What the estimate still excludes (host-side Haiku calls, web-search fees, SDK-vs-billing drift) is registered in STRATEGY §24.55.

#### Panel: `SPEND BY CLASS`
A four-row breakdown of the last 24 h of LLM/API spend by **traffic class** — `owner chat`, `autonomous ops`, `public sandbox`, `host processing` — each row a 24 h `$` total plus a tiny 24-bucket sparkline of the hourly trend. This is the deeper-cut companion to `COST & CACHE`: where that panel answers "what does this cost?", this one answers "*where does it go?*" — and it surfaces **host-side spend** (the sim's recruiter prose, the sanitizer's LLM pass) that the per-turn capture never saw, the strongest version yet of the "real cost, transparent" credibility move.

> **Build note (per STRATEGY §24.69 — Deep Dive 3).** Sourced from `request_telemetry` (the §24.68 per-request table — every owned choke point, every class) via a new `GET /api/observability` aggregate endpoint. The portal reads an **aggregate-only** projection (per-class hourly cost sums — no error text, session ids, or per-request rows; §9's public/private boundary held by a structurally PII-free query + a regression test). The sparkline is a static inline SVG (no chart lib; deterministic for visual baselines).

> **Build note (STRATEGY §24.84 — T5).** The merged `LLM SPEND` box now leads with **two equal big-number amounts, bookended**: the 24h spend (left) and the **cache-hit rate** (right) — both the same `text-2xl` `Metric`, each with its label + explain-on-tap InfoTip beneath. The cache lives in this box on purpose (it's a *cost lever*, the reason the spend is low), so it earns equal billing rather than the old small inline `cache NN%` afterthought. They sit on one `justify-between` row beside each other, so the tile adds no height and the four-box stat-row stays uniform; the per-class chart + legend below are unchanged. Cache still renders only when a rate is present (a no-turn state shows just the spend).

> **Build note (STRATEGY §24.85 / §24.86 — T6).** Two passes on the same ⓘ. **§24.85 (glyph):** the `InfoTip` ⓘ trigger draws its "i" as a **centered inline SVG** (a dot + rounded stem in a symmetric viewBox, `currentColor`) instead of a text glyph — a flex-centered text "i" centers on its advance box, not its ink, so the sans glyph's side-bearings + baseline left it visibly off-center. **§24.86 (circle vs text):** the ⓘ *circle* also sat ~1 px low relative to its adjacent uppercase label, because `items-center` centers it on the text's line box while all-caps ink sits high in that box (empty descender space) — a `-translate-y-px` nudge optically centers it on the caps. Both fixes are one component change → every InfoTip across `/dashboard`, `/architecture`, `/pipeline`, the trace seal, etc. inherits the identical centered glyph + alignment. The circle, size, colors, focus ring, and `DisclosureTip` interaction are unchanged.

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

> **Build note (backend increment, STRATEGY §24.33).** The `ANONYMIZATION DEMO` "wow-finish" now ships. Faithfulness is the whole point: the transformation runs the **real** `src/modules/portal/sanitizer.ts` server-side (`applyPass1` regex + the extracted `redactCompanies` Pass-2 core) via `POST /api/sanitize-demo` — never a frontend re-implementation that could drift from the pipeline actually protecting the candidate's data. Two safety rules keep it honest: **synthetic input only** (the endpoint serves fixed, server-authored synthetic samples — fake emails/phones/$/URLs + a *synthetic* company; arbitrary visitor input is out, so the "Demo data — synthetic only" label stays true and there's no free-sanitizer-as-a-service), and **no real data** (company obfuscation runs against a synthetic application mapping, never the real `applications` table). The panel renders `{ raw, sanitized }` + the redaction count + a "show another" control. Deferred: arbitrary input + rate-limiting (Phase 9); Pass-3 stays a no-op, so the demo shows the Pass-1+Pass-2 reality.

> **Build note (STRATEGY §24.35 Pass B — relocated).** This panel **moves off `/live`** into the `/architecture` `pub-sanitize` node's modal (§5.5): the demo proves the sanitization pipeline, so it belongs beside the node that *is* that pipeline, and on `/live` it interrupted the live-now narrative. The endpoint (`POST /api/sanitize-demo`) and the synthetic-only / faithful-real-sanitizer rules are unchanged — only its home moves, and the fetch becomes **lazy** (fired when the node modal opens).

> **Build note (STRATEGY §24.35 Pass C — trace stream).** Two `AGENT TRACE STREAM` refinements: (1) the auto-scroll now re-fires on every new event even when the ring buffer is at its cap (keyed on the newest `seq`, not the event count — which goes constant at the cap and silently stalled the scroll) and **smooth-scrolls** when motion is allowed; (2) the per-turn `category='turn'` summary row (§24.34) renders as a **batch-sealing separator** — a rule with the real metrics inline (`── turn · model · tok · $cost · latency · cache✓ ──`) — instead of a peer action line, so it reads as the economic seal on the actions above it, not a sibling event.
>
> **Refinement (STRATEGY §24.45).** A seal must *seal something*: a `turn` row renders only when ≥1 action line has appeared since the previous turn. A run of bare/consecutive turns — silent direct replies, cheap-out curator sweeps, action-light Haiku turns — collapses to nothing instead of stacking as a wall of empty rules (the "strange-looking activity" the owner saw once the §24.44 tier shifted to Haiku). A window of *only* turns reads as the quiet "no agent activity yet" state, not a no-match.

> **Build note (dimensional stability, STRATEGY §24.36).** The four top stat panels share one height-equalized grid row with a `minmax(196px, auto)` floor. The floor was calibrated to the LIVE-mode `System status` height, but in **SHADOW mode** (`live_mode: false` — the dev/pre-prod default) the shared `ModeBanner` rendered an inline explainer sentence that wrapped in the cramped panel cell, pushing `System status` to ~214px and dragging the whole equalized row (all four panels) past the floor on load. Fix: `ModeBanner` takes a `compact` flag (used only by the `/live` `SystemStatusPanel`) that moves the shadow note + any pause `reason:` line to the chips' tooltips instead of inline prose, so the panel's height is **mode-independent** and the 196 floor binds in both LIVE and SHADOW. The roomy `/architecture` header keeps the explainers inline (default, non-compact). Chosen over simply raising the floor (which would calibrate to one mode and leave dead space in the other). The LIVE-mode visual baseline is unaffected (compact == non-compact when there's no shadow/reason prose).

---

### 5.3 `/simulator` — Recruiter Simulator

> **Build note (STRATEGY §24.72, 2026-06-16) — shipped as "Watch me apply to your role."** The copy/ASCII below is the original spec; the route is unchanged (`/simulator`, share links persist) but the spoke was reframed. It's branded **"Watch me apply to your role"** (the balloon-animal arc — name your role → watch it run → keep the gift); the nav item is **"Watch it work"** and the nav splits SYSTEM-SHOWCASE | PERSONAL (with `Work`→`Experience`); the input button is **"Watch me apply →"**; the subline is explicit that nothing is submitted. A run ends in **two equal gifts**, rendered by one shared `SimResult` so the **live done-state ≡ the share page** by construction: the **tailored résumé** (downloadable PDF + preview — an inline `<dialog>` modal on desktop, a direct new-tab open on mobile — and an accurate "Preparing…" download state) and a **cold-outreach email** framed honestly as a **sample draft** (subject + 2-line sneak-peek, expand/collapse). The résumé prose is dropped (the PDF is the artifact); the agent activity collapses below ("See how my agents worked") with a "⤷ research" badge showing the consumer subagents build on `research-company`'s digest. Honesty is layered — bullets snapped to master, the bio mechanically backstopped (master-summary fallback on an unverifiable number), an Approved-figures prompt lever, and the email-as-sample-draft framing. Full model: **STRATEGY §24.72**.

> **Build note (STRATEGY §24.81 — T3 download-control polish).** The résumé download/preview is now one shared `ResumeDownload` component (also used by `/experience`): a progressively-enhanced `<a href download>` that JS-hijacks for the "Preparing…" beat + the server `Content-Disposition` filename + a `window.open` fallback, with the idle/loading labels grid-stacked so the button never resizes. Desktop layout: **Download fills the row (primary, `sm:flex-1`), Preview stays compact** beside it — no dead space; mobile stays stacked full-width.

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

> **Build note (STRATEGY §24.31 Δ 2026-06-10):** the timing/cost figures in this section ("20–30s", "~$0.04") were pre-build estimates — a real run takes **a few minutes** and ~$0.25; the shipped copy says so honestly and the ACTIVITY pane carries a live elapsed ticker. The rate-limit indicator is NOT rendered until the per-IP cap actually exists (a displayed-but-unenforced limit is fabrication) — **that cap lands in STRATEGY §24.70 / 9.4a** (the backend `checkSimulatorAllowed` per-IP daily count keyed on the CF-verified visitor IP — `sandbox_per_ip_daily_run_cap` — layered with a global $-budget, Turnstile, and a Workers-RL burst at the edge), at which point the indicator can render against the real remaining-runs count. The share page additionally renders the run's persisted activity trace as an expandable section (`simulator_runs.trace_json`, migration 128).

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

> **Build note (STRATEGY §24.35 Pass D).** The owner asked whether the simulator's resize-on-run is intentional — it is: running widens `main` from `max-w-2xl` → `max-w-6xl` and reveals the two panes, the deliberate Apple→ops register switch (above), a one-time transition on Run; the panes are height-bounded (no in-run jitter), so it's left unchanged — unlike the funnel board's content-jitter, which was a real layout bug (fixed in §5.4 / Pass D).

---

### 5.4 `/pipeline` — the funnel race detail (visitor label: **Job Pipeline**)

> **Naming (owner call, 2026-06-10; supersedes "Momentum", 2026-06-03; see STRATEGY §24.59).** Route + visitor label = **Job Pipeline** / `/pipeline` (with a redirect from the old `/pipeline`, `?app=` preserved). "Momentum" was the gamified horse-race framing but failed instant-understandability; "Job Pipeline" says what the page is, and the "Job" prefix disambiguates from CI/CD pipelines for a dev audience. Everything internal stays **funnel** — `/api/funnel`, `public_funnel_view`, the `Funnel*` components, `funnel_events`, the `funnel_curator_*` config keys (the subagent itself is renamed `pipeline-scribe`, §24.59). The rest of this section uses "funnel" as that internal domain term.

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

> **Build note (per STRATEGY §24.57).** The drawer is deep-linkable: `/pipeline?app=«application_ref»` opens that card's panel once the funnel data loads (an unknown ref is a no-op; closing the panel clears the param). The `/live` Recent-outcomes rows link here — a static outcome list becomes navigation into the drawer that already existed.

> **Build note (STRATEGY §24.60 — interactivity pass 2).** The drawer + tiles grow their explainers and the reverse link: (1) the **win-confidence section gets an InfoTip** — an AI-scored 0–100 estimate recomputed as recruiter signals arrive (stage, response cadence, tone); the rationale sentence is the model's own; a heuristic, not a probability; (2) each of the **four stat tiles gets an InfoTip** with its honest derivation (calendar windows, active-only averaging, the heuristic label); (3) the drawer gains a **"Live activity →" link** to `/live?app=«ref»` — that application's rows filtered out of the live trace window (the honest version of a "related artifacts" modal; the per-application timeline endpoint stays deferred). Trace lines link back here (§5.2), so the two pages now cross-navigate per application in both directions.

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

> **Build note (STRATEGY §24.35 Pass D).** Two refinements: (1) the per-card bar now renders **`win_confidence`** (the heuristic, with a muted `~N%` label) rather than the card's stage position — the column already conveys the stage, so the bar carries new per-card info; null `win_confidence` → no bar. (2) The board holds a **stable height regardless of per-lane card counts** — `items-start` (sparse/empty lanes no longer balloon to match the tallest) plus a fixed lane height with internal scroll, so a lane that piles up scrolls internally instead of jumping the whole board (and the footer/rail below it). Observed live on `dev:mock` (six cards piled into `OFFER` ballooned the board to 763px before the fix).

> **Build note (STRATEGY §24.65 — interview-kit surfacing).** Two additions feeding the §5.9 dossier page: (1) a funnel card whose application has kits carries a small **`▤ kit` mono chip** (`▤ 2 kits` when several) in the same glyph register as `◆ public` — the board-level existence cue; (2) the drawer gains an **"Interview prep" section** (after the fact grid): one document-row per kit — round label + interview type + interview date (day granularity) + an `archived` badge where applicable — each row a link with a `→` affordance into `/kit?app=«ref»&round=«round»`, plus an InfoTip explaining what a kit is and the sealing model. All kits show, **including archived** (§24.65 D1) — a closed process keeps its prep story. Metadata rides `/api/funnel` (`interview_kits` per application); kit *content* never does.

> **Build note (STRATEGY §24.79 — T1 finishing pass).** Three polish refinements from the owner watching the board live: (1) **Stat-tile InfoTips trimmed to the one that earns it.** `Applications YTD`, `Interviews this month`, and `Offers` lose their InfoTips (clear from the label); only `Avg days active` keeps one — it's a labeled heuristic whose caveat (active-only averaging, closed excluded) isn't derivable from the name. (2) **Context-aware stage names from a single source.** `frontend/src/lib/pipeline-stages.ts` carries each stage's **short** code (`APP`/`SCREEN`/`TECH`/`FINAL`/`OFFER`) and **long** name (`Applied`/`Screening`/`Tech interview`/`Final interview`/`Offer`); the destination board renders the long names (caps via CSS, natural-case `aria-label`), the compact strips that *link to* the board (the `/dashboard` rail + the home strip) render the short codes. (3) **Taller desktop lanes that scale with viewport** — the board lanes move from a fixed `16rem` to a `lg` clamp (`clamp(20rem, calc(100vh − chrome), 46rem)`) so a desktop fits more than two cards per lane; tablet stays `16rem`, mobile stays stacked, and the loading skeleton tracks the same height (no resize). **Out (owner call, 2026-06-17):** stage icons (the card glyph vocab already carries the load; a shared interview icon would blur the three interview stages on the compact strip) and applying the same taller-lane scaling to `/dashboard` (its trace stream is already taller and shares a two-panel row — uniform scaling risks an unbalanced grid).

> **Build note (STRATEGY §24.87 — refinement to the above).** The §24.79 D2 "compact strips always render the short code" is relaxed for the **marketing-home strip only** (§5.1): it's wide enough on desktop to carry the long names, and they read better there. `PipelineCompact` gains an opt-in `expandLabels` — short code below `lg`, long name at `lg+` (one line, caps via CSS) — which the home `/` strip sets and the narrower `/dashboard` rail does not (the long names don't fit the side-panel column). Mobile `/` stays the short code.

---

### 5.5 `/architecture` — Live system map

**Purpose:** Prove the engineering. Engineers see a real running system diagram with live status.

**Layout:** Ops register. Center of viewport is the architecture diagram itself, drawn in SVG, with live status overlays:

```
                                ┌─────────────────────────────────────────┐
TRIGGERS ────────────────────►  │  HOST (Node)                            │
                                │                                         │
   Telegram (the candidate) ──► │  [Router ●] ─► writes to session inbound│
   Portal sandbox (web)     ──► │  [Sweep  ●] ─► due scheduled work,      │
   Google Workspace         ──► │                recurrence, stuck-       │
     (Gmail · Calendar ·        │                container recovery       │
      Drive — close-detection   │       │                                 │
      polling; drafts + kit     │       ▼                                 │
      Docs written back)        │  [Session DB] (inbound + outbound .db)  │
   Cron sweep (60s)         ──► │                                         │
                                │  [OneCLI gateway ◇] — container egress  │
                                │    proxy; credentials injected on the   │
                                │    wire (a container never holds one)   │
                                ▼       ▼                                 │
                ┌───────────────────────────────────────┐                 │
                │  CONTAINER (Bun) per session          │  ◀── isolated   │
                │                                       │      per        │
                │  @anthropic-ai/claude-agent-sdk       │      session    │
                │       │                               │                 │
                │       ▼                               │                 │
                │  ORCHESTRATOR (model tier per config) │                 │
                │       │                               │                 │
                │       ├─► tools (in-process MCP):     │                 │
                │       │     analyze_jd                │                 │
                │       │     update_application        │                 │
                │       │     record_funnel_event       │                 │
                │       │     record_progress           │                 │
                │       │     create_gmail_draft        │                 │
                │       │     query_job_leads  …        │                 │
                │       │                               │                 │
                │       └─► subagents (six):            │                 │
                │             research-company  (read)  │                 │
                │             tailor-resume     (read)  │                 │
                │             draft-outreach            │                 │
                │               (reversible Gmail drafts)│                │
                │             build-interview-kit       │                 │
                │               (kit Docs → Drive)      │                 │
                │             scrape-jobs (job_leads) ──┼─► [Job search   │
                │             pipeline-scribe           │    API ◇]       │
                │               (public funnel view)    │                 │
                │             │                         │                 │
                │             ▼                         │                 │
                │       [Portkey AI Gateway ◇]          │                 │
                │         (every LLM path — incl. the   │                 │
                │          host's own: sanitizer pass 3,│                 │
                │          win-confidence scoring)      │                 │
                │             │                         │                 │
                │             ▼                         │                 │
                │       [Anthropic Claude API ◇]        │                 │
                └───────────────────────────────────────┘                 │
                                                                          │
                                ┌───────────────────────────────────────┐ │
                                │  PUBLIC                               │ │
                                │                                       │ │
                                │  [Sanitization pipeline ◇]            │ │
                                │    (3 passes; fail-safe = withhold)   │ │
                                │       │                               │ │
                                │       ▼                               │ │
                                │  [public_audit_trail DB ●]            │ │
                                │       │                               │ │
                                │       ▼                               │ │
                                │  [Public API ●]   ─► REST + SSE       │ │
                                │       │                               │ │
                                │       ▼                               │ │
                                │  [Cloudflare Tunnel ◇]                │ │
                                │       │ ▲ service-token auth          │ │
                                └───────┼─┼─────────────────────────────┘ │
                                        ▼ │                               │
                                  [Cloudflare Worker ◇] ◀── serves this   │
                                    page AND proxies every /api/* call    │
                                    (JSON + SSE) — the browser talks      │
                                    ONLY to the Worker                    │
                                                                          ▼
                                                                     (you are here)
```

The diagram has three regions:
- **TRIGGERS** — what can wake the system: chat input from the candidate, sandbox visitors, Google Workspace close-detection polling, the cron sweep.
- **HOST + CONTAINER** — NanoClaw's two-process model. The host orchestrates (and holds the OneCLI credential perimeter); the container is where the agent loop runs.
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

> **Build note (STRATEGY §24.35 Pass B).** The node click-through is now a **grow-into-centered-modal** (motion `layoutId` shared-element from the node's box → centered; reduced-motion → instant), not a right drawer (`/pipeline`'s `DetailPanel` keeps its drawer — intentional divergence). The `pub-sanitize` ("Sanitization") node's modal **hosts the live anonymization demo** — the real sanitizer over synthetic input, lazy-fetched on open, relocated here from `/live` (§5.2) because it proves the very pipeline that node *is*. That node therefore carries a distinct `▶` **interactive marker** (not the structural `◇`), and the "what you're looking at" panel gains a **"see the sanitizer run →"** control that opens it — so the privacy proof isn't buried behind a guess.

> **Build note (STRATEGY §24.63 — the Track I audit, 2026-06-10).** The ASCII above and every node's modal copy were reconciled to the shipped system: the D12 Worker-proxy public path, the three-pass sanitizer (fail-safe = withhold), the current six subagents with their writer/read-only split, Google Workspace as polling + write-back (drafts, Drive kit Docs), no model-version claims. Two nodes added: the **OneCLI gateway** (host band — the copy is honest that it was inherited with the NanoClaw fork; links its public GitHub repo) and an **aliased "Job search API"** (the vendor goes unnamed on the page per §24.63 D1 — active Google litigation — while the repo still names it internally). Dev-only fixtures (recruiter-sim, dev inspector) are deliberately not drawn. The diagram layout grew two slots (host band → three, container external row → three) with the same 760×736 viewBox.

> **Build note (STRATEGY §24.69 — Deep Dive 3).** Four nodes the §24.28 honesty rule had drawn as *structure with no health claim* now carry a **real probe** — the §24.68 `request_telemetry` table is genuine per-request evidence, so lighting them is honest, not a fake-green dot. **Portkey gateway**, the aliased **Job search API**, **Google Workspace**, and the **OneCLI gateway** derive status from per-provider 24 h error-rate + last-success age (healthy / degraded / down / `idle` when there's been no recent call — still no claim without evidence). Their modals gain **aggregate facts** (requests-24h, error rate, last-success age, p50 latency) — aggregate-only, never raw error text. The **Orchestrator** node's modal additionally shows **session topology** (active sessions split into owner-chat / autonomous-ops / public-sandbox per §24.67). Still structural (honestly unlit): the Anthropic API (we probe Portkey, the gateway in front of it — not Anthropic directly), the edge/tunnel, and the trigger sources. The thresholds are config tunables (§24.69 D7). Source: `GET /api/observability`, same aggregate-only endpoint as the `/live` SPEND BY CLASS panel.

> **Owner-only surface — `/dev` health panel (STRATEGY §24.69 D8).** Not a public portal surface: the dev inspector (`ENVIRONMENT==='dev'`, owner-gated, 404 elsewhere) gains a health panel rendering `runHealthChecks()` — every finding's severity, detail, and concrete `next_step` command verbatim, the §24.68 triage runbook in-browser. Live probes (which exec/spend) stay CLI-only; the panel runs `skipLiveProbes`.

> **Build note (STRATEGY §24.80 — T2, two more honest promotions).** Two of the trigger-source nodes the §24.69 note still drew as *structure with no health claim* now carry a **real probe**, because the host owns a genuine signal for each: **Web sandbox** folds the `simulator_enabled` kill switch + the 24 h sandbox spend vs. the `sandbox_daily_global_budget_usd` cap (`down` when disabled, `degraded` at the daily spend cap, `idle` with no runs, else healthy — the owner's "is the public demo still affordable" view); **Cron sweep** reads the 60 s host sweep loop's last-run age (`healthy` when fresh, `down` when the loop has gone silent). The sweep badge claims only that the loop is *alive* — by-design quiet-hours skips stay healthy (its modal says some work is intentionally deferred, and points at the `pnpm health` queue-starvation finding for deep missed-job detection). **The Anthropic API node deliberately stays structural** (owner call): every model call is logged as the Portkey gateway, so a derived badge would just mirror Portkey's and could misblame the gateway on Anthropic — we keep probing the gateway we can see, not the model behind it. **Idle audit:** every current `idle` use is honest (cold-load transient, an on-demand node at rest with nothing running, or a quiet provider) — `idle` is kept, and the node modal copy now says plainly that idle means *at rest, not broken*.

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

> **Build note (STRATEGY §24.71 / Phase 9.4b — the agent-composed model):** the live `/work` is **auto-composed by the agent**, not hand-filled. The owner provides the **basics + a natural master resume** via Telegram onboarding; the agent composes the structured page *at write-time* (it never runs an LLM in the SSR hot path — a public-route cost/abuse vector per §24.70) into the `WorkProfile` shape, which is the **agent's output contract**. The composed page persists as `candidate_profile.work_profile_json`; `GET /api/profile` projects it deterministically (placeholder fallback). It **composes, never invents** (facts trace to the source resume) and shows a **provenance marker** ("composed by the agent from the master resume") — the page itself becomes a second AI showcase. Staged: **9.4b-1** the deterministic projection (instant de-`Jane Doe`, works on a hand-seeded artifact too); **9.4b-2** the write-time composer + provenance + owner preview/recompose.

> **Build note (STRATEGY §24.72 / Phase 9.4b — the résumé PDF):** the Download-PDF is **server-rendered from the `WorkProfile` via `@react-pdf/renderer`** (deterministic layout from structured data — no headless browser, no per-render eyeballing; the same engine powers the tailored résumé below). `GET /api/resume.pdf` renders on the backend and streams through the Worker BFF; the page and the PDF share one `WorkProfile` source, so they can't drift. Every PDF carries an **AI-provenance footer** (transparency + a conversion vector when the file is forwarded). **Tier 2 (§24.72):** the simulator generates a résumé **tailored to the recruiter's own role**, downloadable from the results, with a cross-sell here ("Want one aimed at your role? Run the simulator →") — tailoring is *re-emphasis of real experience, never fabrication*.

> **Build note (STRATEGY §24.81 — T3).** The Download-PDF button now shares the `/watch` results page's polished download behavior via the one `ResumeDownload` component — the "Preparing…" state, the server filename, the graceful fallback, and the no-resize grid-stack — while keeping its quiet `outline`/`sm` register and **no** preview modal (the page already *is* the résumé, and the button appears twice). Still a real `<a href download>`, so it works JS-disabled.

> **Build note (STRATEGY §24.83 — T4).** Two changes. (1) The résumé sections adopt the shared `LongformDoc` scaffold (§5.9 build note) — a sticky scroll-spy TOC (desktop rail / mobile chip strip) over the existing masthead — so a long résumé navigates like the kit; `WorkSections` computes the list of *present* sections (omit-when-empty already), so a partial profile shows a shorter rail. (2) The **"Where else to find me / Elsewhere"** social-links section is **removed** — the sitewide footer (§8.2 / §24.76) is now the single socials strip, and repeating GitHub/LinkedIn per-page is redundant. Item 8 above is retired by this note.

> **Build note (STRATEGY §24.88 — owner polish).** Two foot-of-page nits. (1) The **second** "Download résumé (PDF)" button read as a bare duplicate; it's reframed as a deliberate end-of-page affordance with a `border-t` separator (kept, not removed — a download once the masthead one has scrolled away is a real convenience; the framing was the fix). (2) The **mobile cross-sell** "Want one aimed at your role? Watch me apply to it →" orphaned its arrow onto its own line; the CTA half is wrapped `whitespace-nowrap` so the line breaks between the question and the CTA — two clean lines on mobile, one on desktop.

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

Below the form, the "reach me directly" paths:
- **Email** (`mailto:` link)
- **LinkedIn**
- **GitHub**

> **Build note (STRATEGY §24.71 / 9.4b-3).** These paths are **SSR-driven from the candidate's canonical `identity`** (`GET /api/profile`, read from `candidate_profile` columns — `public_email`, `linkedin_url`, `github_url`), each rendered only when set; the whole section is omitted when none are. No hardcoded placeholder links. **Telegram is dropped** (owner-only admin channel, locked strict — the form is the visitor path; owner call 2026-06-14), superseding the original "public bot deep link" path here and the §12 "Public Telegram bot username" row.

> **Build note (STRATEGY §24.83 — T4): the "reach me directly" section is removed.** The plain-text **email** there was a scraping leak that contradicted the footer's deliberate email exclusion (§8.2 / §24.76), and the **LinkedIn/GitHub** links duplicated the now-sitewide footer socials strip. So the whole "Or reach me directly" block is dropped: `/contact` = the relay form, and the footer (on this page too) carries the socials. Email reaches the candidate only through the form. (The same `mailto:` leak in the home "Talk to me" block is removed in the same pass.)

When submitted, the message is relayed to the candidate via Telegram. Sender gets a confirmation: *"Sent. the candidate typically replies within 24 hours."*

**Spam control:** Cloudflare Turnstile captcha (invisible by default) + a per-IP burst rate-limit, both enforced **at the Worker edge** before the submission crosses the tunnel (STRATEGY §24.70 / 9.4a — the BFF proxy is the only thing that sees a raw visitor request under the §24.39 D12 topology). The original "5/IP/hr" framing is approximated by a 60 s Workers-RL burst (Workers RL only does 10 s/60 s windows); an hourly Durable-Object cap is deferred for `/contact` (it spends no money — just relays — so Turnstile + the burst is sufficient; the DO $-budget/per-IP machinery is spent on the simulator, which does).

> **Build note (the conversion sink — STRATEGY §24.30 / Sub-milestone 8.1).** `/contact` is the single sink every journey path drains toward (§2), so it is pulled forward from Phase 9 into the conversion spine. It ships over the already-built `POST /api/contact` relay (`relayContactSubmission` → the owner's wired channel, e.g. Telegram — verbatim, not persisted, not sanitized, one-way, LIVE_MODE-independent) with react-hook-form + Zod (the **§3.5 Forms** choice). It reads **carried context** — typed `useSearch` `?company=&role=&from=` prefills the form (the simulator's `[Talk to me]` passes the role/company it just ran; every connective-rail convert link passes `from`) — and **relays `from` as `source`** so the owner notification shows where a lead engaged ("Came from: live"). So a convinced visitor converts in one step, not a cold form. **Submission path:** 8.1 ships the direct browser→`/api/contact` post (the relay's documented *dev* path); the Worker BFF proxy (Worker → Tunnel, the §24.39 D12 path, now built) + the Turnstile captcha + per-IP rate-limit (§10) are the **Phase 9.4a** hardening (STRATEGY §24.70: `guardPublicMutation` in `$.ts` siteverifies the `x-turnstile-token` header + Workers-rate-limits `POST /api/contact` before forwarding) — until that deploys, the relay's own validation + its deliver-only-if-a-channel-succeeded gate stand in (in dev:mock / E2E no channel is wired, so a submit honestly returns 503 → the form's "reach me directly" state).

---

### 5.8 `/about` — The story + methodology (the "tell" surface)

**Two doorways, never the header (STRATEGY §24.75).** This is the site's one *deep, optional* read for the visitor who wants more than the page in front of them. It is reached exactly two ways, framed for two motivations: from the home pitch beat (§5.1 Viewport 1.5) as **"Read the full story →"** (the freshly-hooked visitor who wants the narrative), and from the footer (§8.2) as **"About"** (the conventional background slot). It is deliberately **not** a top-nav item (the §8.1 rule: header = the journey, footer/background = depth). The route stays `/about` — the `#anonymization` deep-link (from `/work` + the funnel obfuscation note) and the footer/home references already point here, and the URL sits behind framed link text anyway.

**Why this page, and why story-first.** It is the companion to the `/architecture` *proof* surface (§5.5): `/architecture` **shows** the live system; this page **tells** the story and substantiates the claims — they don't duplicate (this page links *out* to `/architecture` for the live map and the repo for the code, never re-draws them). It opens with the value narrative — the long version of the §5.1 beat, in the candidate's voice, on *what the system does and why it's a smart way to run a real job search* — and flows into the substance a skeptic reads next. Story → substance, one coherent read:

1. **The story** — the plain-English value narrative, candidate's-POV (the §5.1 beat, at length).
2. **How it works, in words** — the loop explained plainly for a non-engineer; links to `/architecture` for the live map and GitHub for the code (no diagram re-draw here).
3. **Meet the cast** — the agent roster via the §8.6 cast registry (`lib/ai-actors.ts` + `AgentRef`); no new content model.
4. **Anonymization policy** (`#anonymization`) — the rules (see §9).
5. **The two-tier vault** — credential & data privacy (see "Two-tier vault" below); a credibility move with engineering visitors.
6. **Visitor privacy** (`#privacy`) — the first-party visit log, stated plainly (see "Visitor privacy" below; this is the STRATEGY §24.74 D4 disclosure, landing here; the footer's "Privacy" link anchors here, §8.2 / §24.76).
7. **System modes & safety controls** — high-level, linking to §7.
8. **Cost of running this thing** — live *estimates*, honestly labeled (see the cost note below).
9. **Why these specific tech choices** — NanoClaw, Claude Agent SDK, Portkey (Model Catalog), OneCLI, TanStack Start.
10. **How to fork it for yourself** — generic-by-design, the repo is meant to be forked (see "How to fork it" below).
11. **Honest limitations** — what this system doesn't do (anti-claims build credibility).
12. **FAQ** — common recruiter questions.

Marketing register throughout (calm, `max-w-prose`), opening warm/narrative and deepening into precise/technical — a normal long-form arc. The connective rail's existing `/about` row (§8.4) applies.

> **Build note (STRATEGY §24.83 — adopt the `/kit` reading model).** This is a wall of ~12 sections with no nav aid, so it adopts the shared `LongformDoc` scaffold (§5.9 build note): a document masthead + the sticky scroll-spy TOC (desktop rail / mobile chip strip + the mobile ‹ › prev/next steppers), no `⊘` (no sealed sections — the steppers just walk section-to-section). Sections carry a short TOC `nav` label distinct from the full section `heading` so the rail stays scannable while headings stay sentence-length; the `#anonymization` + `#privacy` deep-link targets remain section ids. The warm-story register and the live cost/cast content are unchanged — only the navigation is added.

> **Cost note (STRATEGY §24.75 — reuse, don't rebuild).** The cost section renders from the **existing public** `GET /api/telemetry` — `turn_cost_cents_total` + `sim_cost_cents_total` (the combined headline) and `cache_hit_rate` — the same data `/live`'s "Cost & cache" panel already shows. No new endpoint, and no "should real $ be public" decision: the number is *already* public on `/live`. The earlier wording here — "live numbers, **not** estimates" — is reconciled to the honest reality: the Agent SDK resolves **estimates** only (exact per-call figures need Portkey's Enterprise admin key, STRATEGY §24.47), so the figures render **labeled `est`**, exactly as on `/live`. "Live estimates, honestly labeled" — the honesty rule wins over the aspiration.

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

#### Visitor privacy (the first-party visit log)

A short subsection that says the quiet part out loud — the site keeps a basic, first-party log of visits, and is honest about it rather than reaching for a third-party tracker (STRATEGY §24.74 D4):

> This site keeps a **first-party** log of visits — no third-party trackers, no cross-site cookies, no ad-tech. When the agent puts a link to this showcase into something it sends out (a cold-outreach email; a résumé that gets forwarded), that link carries a short opaque code so a click tells me *which* outreach it came from — that's the whole point of a public job-search showcase. The log records a **salted hash** of your IP (so I can tell a repeat visit from a new one without storing the raw address), a coarse country/region, and which page you landed on. It's retained for a bounded window and then deleted, and it's visible only to me behind an authenticated admin page. I deliberately **declined** Cloudflare's free analytics beacon — it's aggregate-only and would add a third-party script, and I'd rather keep the whole thing first-party and legible.

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

### 5.9 `/kit` — Interview-kit dossier (STRATEGY §24.65)

**Purpose:** Surface the agent's richest artifact — the two-part interview kit (§24.53) — as a *real document with visibly sealed sections*. The privacy model is the centerpiece, not an apology: a visitor sees a genuine prep dossier whose identifying sections are honestly redacted while the process is live, and shown in full once the application is revealed post-close.

**Reached from:** the §5.4 drawer's "Interview prep" rows → `/kit?app=«ref»&round=«round»` (query params, matching the established `?app=` deep-link convention). Browser back lands on `/pipeline?app=«ref»`, which re-opens the drawer (URL-as-source-of-truth, §24.58) — the navigation-stack feel with zero new dialog code. Deliberately **not** a second dialog stacked over the drawer: `useDialog` is single-layer (§8.5), and a long document wants a page, not a modal.

**Layout (ops register, document treatment):**

```
┌──────────────────────────────────────────────────────────────┐
│  [ai-infra-a]                                    INTERVIEW KIT│
│  Senior Platform Engineer                                     │
│  ROUND TECH_SCREEN · TYPE technical_screen · JUN 12 · ACTIVE  │
│  ── This process is live — sections that would identify the   │
│     company are sealed. Revealed post-close, it shows in full.│
├──────────┬───────────────────────────────────────────────────┤
│ Part 1   │  ## Part 1 — Interviewer operating manual         │
│  Your    │  *read by the interviewer Claude during the       │
│  role    │   voice mock*                                     │
│  Rubric  │                                                   │
│ ⊘ Themes │  ### Your role                                    │
│ ⊘ Ground │  Conduct a realistic technical screen for…        │
│ ⊘ Gaps   │                                                   │
│ Part 2   │  ### Scoring rubric                               │
│ ⊘ Signal │  - Problem decomposition — strong: …              │
│  Lean    │                                                   │
│ ⊘ Ask    │  ### Question themes                              │
│          │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                       │
│ (sticky  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                              │
│  rail;   │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                          │
│  chips   │  8 question themes · sealed while this process is │
│  on      │  live — they quote the job description.           │
│  mobile) │  …                                                │
└──────────┴───────────────────────────────────────────────────┘
```

- **Masthead** — document-style header: mono title in the drawer's bracket convention (`[ai-infra-a]`, real name + `◆ public` when revealed), role title, then a mono fact strip (`ROUND · TYPE · INTERVIEW DATE · ACTIVE/ARCHIVED`). Below it the **reveal banner**: obfuscated → "This process is live — sections that would identify the company are sealed. If the process is revealed post-close, the kit shows in full." / public → "◆ revealed post-close — shown in full."
- **Sticky section nav (TOC)** built from the kit's deterministic sections: desktop a slim left rail, mobile a horizontal chip row pinned under the masthead (flush against the header — no subpixel gap); scroll-spy highlights the section in view, with the band anchored at the tap-scroll landing offset, and a tapped chip owns the highlight while the scroll settles (§24.65 Δ — the percentage band used to skip short sealed sections and light their neighbor). Sealed sections appear **in** the TOC with a `⊘` glyph — the full structure is visible even when content isn't (provable depth). On mobile, **‹ › steppers** flank the strip and jump between sections *with content* (skipping sealed runs); the active chip auto-scrolls into view.
- **Two-part framing** — Part 1 and Part 2 render as visually distinct documents with honest sub-captions: Part 1 *"read by the interviewer Claude during the voice mock"*; Part 2 *"the candidate's phone cheat-sheet"* (a tighter card, like the pocket artifact it is). The kit's own design intent becomes the visual story.
- **Sealed-section treatment (the centerpiece)** — the real section header, then one **redaction bar** per withheld item (striped CSS bars, `aria-hidden`, deterministic per-index widths so visual baselines hold), plus a visible caption: *"6 grounding facts · sealed while this process is live — they'd identify the company."* Gap notes carry their own: *"sealed while live — names what the candidate would be probed on."* The seal is server-side (§24.65): the payload never contains withheld text; the bars are decoration over an already-safe wire.
- **Content sections** — the shared markdownish renderer (extracted from the simulator output pane), `max-w-prose` reading measure, one subtle entrance fade (root MotionConfig handles reduced-motion).
- **Footer honesty copy** — built by the `build-interview-kit` subagent; lives as a Google Doc in the candidate's private Drive; conducted live as a voice mock; this page is the public projection.

**Calibration (decided, don't re-litigate):** YES to redaction bars, sealed-glyph TOC, two-part framing, dossier masthead, one entrance motion. NO to typewriter/declassify-on-hover effects (would imply the content exists client-side — it doesn't), page-flip/3D, and shimmer over redactions (confusable with loading). A "was sealed while live" marker on revealed kits is a recorded v1.1 flourish.

**States (§10 discipline):** loading skeleton (masthead + a few bars); unknown ref/round or no kit → an honest empty state with a link back to `/pipeline`; a kit whose content predates markdown capture (§24.65 backfill miss) → metadata masthead + "content not captured for kits built before this feature."

**Load behavior:** `/api/kit` is fetched once on page open — a kit is static once built; no polling. Realistic kits are 1–3k words (~10–30 KB JSON) — plain render, no virtualization.

> **Build note (STRATEGY §24.83 — the shared long-form scaffold).** The reading model above (document masthead + sticky scroll-spy TOC: desktop rail / mobile chip strip + ‹ › steppers, all the §24.65-hardened jump/scroll-spy behavior) is extracted out of `KitDossier` into a single reusable `LongformDoc` so the site's other "walls of text" — `/about` (§5.8) and `/experience` (§5.6) — get the **same** navigation. `KitDossier` keeps its kit-specific rendering (parts, redaction bars, pocket card, sealed `⊘` chips) and becomes a *consumer* of the scaffold (`stepper` on; sealed = withheld). The scaffold is content-agnostic: it takes a `{ id, title, sealed? }[]` section list + an `idPrefix` for test-ids, owns the nav + active-section tracking, and renders each consumer's section blocks as children (marked `data-longform-section`). Kit's unit tests + visual baselines are the regression guard for the faithful extraction.

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

In `/pipeline` per-application timeline:
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
7. **Optional portal publication:** the candidate can flip `reflection_published: true` per learning. Published reflections show on the application's `/pipeline` detail panel as a "What I learned" block, with the company still obfuscated unless `public_state = 'public'`.

**Why this matters for the showcase:** A hiring manager who lands on `/pipeline` and sees a closed/rejected entry with a handwritten reflection ("*I underestimated their bar for systems design — leaning into Designing Data-Intensive Applications before my next big-tech round*") thinks: *this is someone who learns in public*. That signal is much harder to fake than competence claims.

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
  Jane Doe    Live    Job Pipeline    Architecture    Simulator    Work    Contact
```

**Order (owner call, 2026-06-03):** lead with the wow (`/live`, the real-time hub the home "See it work →" CTA targets), then its drill-ins (`Job Pipeline`, `Architecture`), then the personal/conversion tail (`Simulator`, `Work`, `Contact`). This clusters the ops surfaces then the personal ones — and ends on the `/contact` sink. (Supersedes the earlier interleaved `/live · /simulator · /funnel · /work` ordering; `/architecture` had also never been listed here.)

**"Job Pipeline" = the visitor-facing label for the funnel page** (owner call, 2026-06-10 per STRATEGY §24.59; supersedes "Momentum", 2026-06-03, which itself superseded "Funnel"). "Funnel" read as sales jargon; "Momentum" was warmer but not instantly understandable. The route is **`/pipeline`** (`/pipeline` redirects); **all internal naming stays "funnel"** — `/api/funnel`, `public_funnel_view`, the `Funnel*` components, the `funnel_events` table, the `funnel_curator_*` config keys. So: public surface = Job Pipeline, internal domain = funnel.

The wordmark is the persona name, **not a domain** — the deployed site is `hire.<DOMAIN>` (`hire.example.com` placeholder) per the locked domain pattern; the earlier `janedoe.dev` here was a stray placeholder, reconciled in STRATEGY §24.25. Sticky on scroll. On mobile, collapses to a **hamburger** (the responsive contract for the nav — and every page — is §13).

**Header vs footer (the IA rule):** the header carries the *journey* — the surfaces a visitor should actively explore (kept to ~6 items). Secondary/background links live in the footer (§8.2): socials, legal/privacy, and **`/about`** (background/story, not a primary destination) — so `/about` is **not** a header item.

> **Build note (STRATEGY §24.82 — header spacing fix).** The nav row widened from `max-w-3xl` → `max-w-4xl` with a guaranteed gap (and `shrink-0` on both the wordmark and the link cluster): the dense six-link grouped nav nearly filled the old box, so a real (longer) `VITE_PERSON_NAME` wordmark pressed up against the first link. The wider box restores ~100px of breathing room for a real name. Same change tightens the grouping — each cluster is its own `gap-4` flex, the larger gap around the dividers makes the three groups (Pipeline·Watch · | · Dashboard·Architecture · | · Experience·Contact) read as groups. Mobile (hamburger) is unaffected. **Active-page indicator:** the current link brightens to foreground AND gets an `accent-cool` underline (text-decoration → zero layout shift), so "you are here" reads at a glance across the six items.

### 8.2 Footer

A single slim, muted band — the **social/legal strip** — sits at the very foot of every page, *below* the §8.4 connective rail (the rail is the directed "what's next"; the footer is the quiet background strip). It carries the persona wordmark, the candidate's socials, the two background links (`/about`, Privacy), and a short "built with" credit:

```
  ─────────────────────────────────────────────────────────────────
  Jane Doe                              (GitHub) (LinkedIn) (Website)
  Built with NanoClaw · Claude · TanStack          About · Privacy
  ─────────────────────────────────────────────────────────────────
```

- **Socials are SSR'd identity, omit-when-null.** GitHub, LinkedIn, X, and the personal website each render only when its `candidate_profile` field is set (the identity SSR principle, §24.71 9.4b-3 — DB-sourced, never hardcoded; a fork with no X account simply shows no X link). Each is a **themed brand icon** — an inline simple-icons SVG path (CC0) drawn `fill-current` so it inherits the muted→foreground color tokens on hover — **not** lucide (lucide dropped brand marks over trademark; lucide's generic globe is fine for the website link). Email is deliberately **not** in the footer — `/contact` and the rail's "Talk to me" own that path, and a footer `mailto:` invites scraping.
- **`/about`** is the conventional background slot (the §8.1 header/footer IA rule: header = journey, footer = depth) — the footer is `/about`'s **second framed doorway** (the first is the home beat's "Read the full story →", §5.1).
- **Privacy → `/about#privacy`** (the "What this site logs about your visit" disclosure, §5.8). There is **no standalone `/privacy` page**: the disclosure already lives on `/about`, so the link anchors there rather than to a near-empty route or a 404. A real privacy page can supersede the anchor later if legal posture warrants.
- The persona wordmark = the build-time `VITE_PERSON_NAME` (the same brand as the §8.1 header). "Built with" is a short, static credit — headline frameworks only, no live data, no staleness.

> **Retired (do not rebuild).** The original §8.2 mock carried a live `SYSTEM STATUS / last-deploy-SHA / cache% / $-per-day` metadata block. That is **retired as redundant** (the §24.35 Pass A call): the status/cache/cost telemetry already lives on `/live` + the §8.3 live indicator, and echoing the same numbers in a sitewide footer is noise without signal. The footer is the slim social/legal strip only. (A repo-linked deploy SHA could return as a small fast-follow if a build-time git-SHA env var is wired — out of scope here.) Built per STRATEGY §24.76.

> **Build note (STRATEGY §24.83 — the email exclusion is sitewide, and the socials strip is canonical).** The "email deliberately not shown / `mailto:` invites scraping" decision above is now enforced *everywhere*, not just the footer: the residual plain-text `mailto:` leaks on `/contact` ("Or reach me directly") and the home "Talk to me" block are removed — the contact form is the only email path. And because the footer is now the single sitewide socials strip, the per-page social-link lists that duplicated it (`/experience` "Elsewhere", `/contact` "Or reach me directly") are removed (§5.6 / §5.7 build notes). Reaching the candidate: socials via the footer (every page), email via the relay form.

### 8.3 Live indicator

Used on `/` and in the footer. A single small dot with `● live` label. Connects to `/api/activity/stream` and pulses on each received event. Disconnects gracefully if SSE drops.

**Resume cursor:** the stream carries a monotonic `seq` (the `public_audit_trail.seq` column) as the SSE `id:` / `Last-Event-ID`. On reconnect the client resumes with `/api/activity?since=<seq>` (or the stream's `Last-Event-ID` header). The cursor is `seq`, **not** `ts` — wall-clock timestamps tie at millisecond granularity (multiple events in one host tick), so a `since=<ts>` resume either duplicates the boundary (`>=`) or skips same-ms siblings (`>`). A monotonic integer cursor makes reconnects across the Cloudflare Tunnel idle timeout exactly-once with no gaps or dupes.

As of Sub-milestone 6.1 (STRATEGY.md §24.24) the indicator + ticker run on the audit fields that exist — `category`, `agent_name`, and the `proactive` flag (captured host-side from the triggering message kind). LLM telemetry (model / tokens / cost / cache-hit / latency) is captured **per-turn** in STRATEGY.md §24.34 on a `category='turn'` summary row (the SDK resolves cost only per `query()`-call, so per-turn is the honest unit); see the §5.1 progressive-rendering note.

### 8.4 Connective rail

The directed "what's next" affordance that makes the journey (§2) physical: **no deep surface is a dead-end.** A slim band at the foot of the page content (distinct from §8.2's metadata footer) presents the contextual next steps for *this* surface — always including the convert path to `/contact`, plus 1-2 deepen/pivot options. Where the top nav (§8.1) lets a visitor jump anywhere, the rail *pulls them forward* along the path their current interest implies — the fix for the "one-shot dead-end" failure mode named in §2.

> **Build note (STRATEGY §24.77 / §24.88).** The route names in the table below predate the §24.77 rename (`/live`→`/dashboard`, `/simulator`→`/watch`); the live `ConnectiveRail.tsx` config uses the new routes. §24.88 also reworded the `/pipeline` *deepen* label **"Watch it live" → "See it run"** — it name-dropped the dead `/live` page and risked confusion with the `/watch` "Watch it work" route; "See it run" matches the other →`/dashboard` deepen labels.

A single `ConnectiveRail` component fed a per-route config, hosted by the register layouts (the `(ops)` shared layout — finally earning its place — and the marketing layout) rather than hand-placed per page. The convert option is the constant; the rest is per-surface:

| Surface | Convert (constant) | Deepen | Pivot |
|---|---|---|---|
| `/` (home) | Talk to me → `/contact` | See it work → `/live` | Try it → `/simulator` |
| `/live` (the hub) | Talk to me → `/contact` | How it works → `/architecture` | Run it on your role → `/simulator` |
| `/architecture` | Talk to me → `/contact` | Read the code → GitHub repo | See it run → `/live` |
| `/pipeline` | Talk to me → `/contact` | Watch it live → `/live` | — |
| `/work` | Talk to me → `/contact` | See the system → `/live` | — |
| `/simulator` (results) | Talk to me (context-prefilled) → `/contact` | Share results | Try another |
| `/about` | Talk to me → `/contact` | Read the code → GitHub | See it run → `/live` |
| `/contact` | — (the sink: no rail; the §5.7 alt-contact paths stand in) | — | — |

Register-aware styling: clean and spacious in the marketing register, dense and monospace in ops. The convert option carries visual primacy (accent-filled) so the path to conversion is always the most prominent next step. Every convert link routes to `/contact` with the originating surface as carried context (`?from=<surface>`); `/live`, as the hub, is the only surface that exposes all three branch directions. Reduced-motion-safe; no auto-animation.

> **Build note (STRATEGY §24.35 Pass A — reachability).** The rail must be *reachable* to do its job. Through 8.x each page `<main>` carried `min-h-dvh` and the rail rendered after it, so on a tall display a short page pushed the rail just past the fold — a directed "what's next" you had to hunt for. §24.35 moves the register layouts to a `min-h-dvh flex flex-col` column (header · a `flex-1` `<Outlet/>` wrapper · rail) and drops `min-h-dvh` from the page mains, so a short page seats the rail at the viewport bottom and a tall page flows it after content (unchanged). **Pinning the rail to the viewport bottom (a persistent `fixed` bar) was considered and rejected (owner-confirmed):** always-available navigation — including the convert path (`Contact`) — is the sticky §8.1 top nav, so no surface dead-ends without scrolling; the rail stays the end-of-page directed handoff (reached at the natural end-of-surface moment) rather than a second fixed band that sandwiches content between two bars and costs vertical space (worst on short laptops / mobile — the displays where the gap is most felt). Relatedly, `/simulator` intentionally carries **no generic rail**: its results view has bespoke run-specific next-steps (`Talk to me` context-prefilled · `Share` · `Try another` · `Download`) that satisfy this table's `/simulator (results)` row, and the idle input view's next-step is to run the sim.

---

### 8.5 Dialogs (modal/drawer) — focus & a11y contract

Two surfaces open as a modal overlay: the `/pipeline` card drawer (a right-edge `DetailPanel`) and the `/architecture` node modal (a centered `NodePanel` that grows from its diagram node). They look different on purpose — a drawer vs. a `layoutId` modal — but they owe the visitor the **same modal behavior**, so it lives in one shared `useDialog` hook rather than being re-derived per surface (where the next dialog inherits whatever the last one missed).

The contract, when a dialog is open:

| Behavior | Why |
|---|---|
| **Focus moves into the panel** on open | The visitor's keyboard/AT context follows the thing that just appeared, not the page underneath. |
| **Tab / Shift+Tab are trapped** inside the panel (wrap at both ends) | The WAI-ARIA APG modal pattern — focus cannot wander to the page behind a modal. |
| **Focus restores to the trigger** on close (the card / node that opened it) | Closing returns the visitor exactly where they were, not to the top of the document. |
| **Escape** closes; the **backdrop** closes | Two conventional dismissals; the backdrop is a labeled button so it's pointer- and AT-clean. |
| **The rest of the page is `inert`** while open | AT + pointer can't reach backdrop content the visitor isn't supposed to be in. Applied by marking off-path siblings from the overlay up to `<body>` — **no portal**, so the modal's grow-from-node `motion` transition is preserved. |
| `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (+ `aria-describedby` where there's a description) | The dialog announces itself correctly; the title/description are the accessible name/description. |

This is the load-bearing answer to the §14 accessibility open-question for overlays (keyboard navigation + focus management), closed for dialogs in STRATEGY §24.36 36.2. New overlay surfaces consume `useDialog` rather than re-implementing it.

### 8.6 AI-authorship marker + the cast registry (STRATEGY §24.73)

The site shows a lot of agent-authored content; it marks that authorship in **one** consistent language, the `✦` provenance marker, so a recruiter always knows what an AI wrote — and *which* AI. This is a cross-cutting component, not per-page copy.

- **The cast registry (`lib/ai-actors.ts`) is the single source of truth.** Every AI *actor* the visitor can see, with `kind`: the six `subagent` specialists, the `host` win-confidence scorer that runs outside the orchestrator loop, and the `system` orchestrator ("my agent system"). Each carries a role, a visitor-facing blurb, and an honest access badge. Anywhere the site names an agent reads from here — never a bare string — so the trace log, the `/kit` footer, the architecture roster, and the win-confidence rationale all agree. (The public-view sanitizer is deliberately absent — it's deterministic regex, not AI; marking it would be a false signal.)
- **`AgentRef`** renders an actor's handle as an explainable term (the AI color, dotted underline) with a tap/click popover (role · blurb · access). It shares the `DisclosureTip` mechanism with the §5.2 `InfoTip` — one interaction contract, not two. It's a `<button>`, so it is never nested inside another button.
- **`AgentMark`** is the `✦` marker built on `AgentRef`: inline (footers, cards, ticker) and block-header (the kit dossier, a rationale) scales. The marker stamps authored **content** at its point of display; pure transforms (sanitization) are *explained* in the registry/architecture but don't stamp every field.
- **The AI color** is a dedicated semantic token (`--ai`, iris/violet), distinct from `primary` (green) and `accent-cool` (cyan/links). It carries the glyph, the `AgentRef` names, and AI-scored data viz (the win-confidence bar + `~%`, the `▤` kit cue) so the AI signal reads instead of blending into the theme.
- **Honest by construction:** an unknown name falls back to plain text (no false chip); host-side output is attributed to its host actor (not a subagent); non-interactive surfaces (the résumé PDF — Inter has no `✦` glyph) use the registry's plain-text form ("the tailor-resume agent"), same signal, wording only.

The surfaces wearing it today: `/work` provenance, the simulator résumé + email gifts + trace, `/kit`, the funnel detail panel (win-confidence rationale, published note) + card data viz, and the `/architecture` Subagents roster. New AI-authored surfaces adopt `AgentMark`/`AgentRef` rather than inventing a marker. Feeds the §5.8 `/about` "how it works" surface.

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

`public_audit_trail` is an append-only *event log*; the funnel surfaces (`/` strip, `/pipeline` board, `/live` compact funnel) need *current state per application*. `public_funnel_view` is a maintained physical projection table (one row per application), written by a host-side hook on every `applications` / `funnel_events` write — the same best-effort, post-commit discipline as the `public_audit_trail` mirror. Columns:

| Column | Meaning |
|---|---|
| `application_id` | PK (links back to the private row, host-side only) |
| `application_ref` | `obfuscated_label`, OR real `company_name` when `public_state = 'public'` |
| `public_state` | `obfuscated` / `partial` / `public` |
| `role_title`, `status` | current canonical status (see the pinned status vocabulary) |
| `stage` | the derived 5-stage value for the funnel strip (Applied / Screening / Tech / Final / Offer, + terminal) |
| `applied_at`, `stage_entered_at`, `last_activity_at` | timestamps — the API/frontend computes "days in stage / pipeline" at read time (never precomputed, so a row never goes stale) |
| `win_confidence` | heuristic %, labeled low-rigor on `/pipeline` |
| `published_learning` | sanitized excerpt of the latest published reflection for this application (nullable) — feeds the `/pipeline` "What I learned" block (§6.7) without the API ever reading the private `learnings` table |

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

> **Build note (STRATEGY §24.36 / Sub-milestone 36.1).** These states get a **consistent visual language** (a shared skeleton primitive for content-shaped areas; the honest "not connected / offline" treatment for degraded externals; concise inline copy for streams) instead of the current ad-hoc per-page handling. Because the seeded E2E/dev DB is always instant + populated, the loading/empty/error states are otherwise unreachable in tests — so a **mock-only request override** (`?__state=loading|empty|error`, honored only by the dev/E2E API, never production) makes each state reachable for `@visual` snapshots, driven live in dev by a small **state-switcher** panel. A production-facing state-preview toggle is deferred (V2_IDEAS #16) — a live site serving fake loading/error states would undercut the "everything here is real" credibility.
>
> **Dimensional-stability standard (Tier 2 — owner call, 2026-06-03; the bar for every async surface, here and in §24.36 36.2–36.5 + the §24.37 mobile work).** A state change must never yank surrounding content: (a) the **loading skeleton reserves the loaded layout's footprint** so loading→ok is ≈zero layout shift (the frequent, watched transition); (b) **empty/error center their message within a reserved region** (a sensible min-height) rather than collapsing the surface to a bare line — and without ballooning into a large empty void on a very tall surface (a ~900px diagram's error state reserves a comfortable framed region, not its full height). Grid-composed surfaces (the `/live` panel grid) are stabilized by the grid row sizing to its tallest cell; single-surface pages (`/pipeline`, `/architecture`) reserve their region explicitly.
>
> **Error boundaries vs offline states (STRATEGY §24.36 / Sub-milestone 36.3).** Two distinct failure modes get two treatments. An **expected async failure** (the backend is unreachable / 500s — the "Backend down" + "Portkey down" rows above) surfaces through each polling hook as the honest per-surface **offline `StateNote`** (streams: "reconnecting") — this *is* the backend-down fallback, chosen granular over a single page-level banner so each panel says exactly what it can't reach. An **unexpected render throw** (a component crash) is caught by a styled, recoverable **`RouteErrorBoundary`** — the cross-cutting boundary wired as the router `defaultErrorComponent` (so it renders inside the layout `<Outlet/>` with the header + rail still present — never a chromeless page) and the root `errorComponent` (last-resort). On-brand copy + a **Try again** (router invalidate) + **Go home**; the raw error/stack is dev-only (visitors never see a trace). Reached for tests via a mock-only synthetic-crash route (the client-side counterpart to the `?__state` seam). **Deferred (not buildable / not yet present):** the *deployed* "Cloudflare Worker serves a stale cached build" path (a Phase 9/10 deploy concern) and the table's **"footer status shows red"** (the §8.2 footer itself is deferred to the `/about` pass).

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

> **Social-meta build-note (STRATEGY §24.36 / Sub-milestone 36.5).** The Open Graph + Twitter-card layer ships via a central `lib/seo.ts` `seo()` helper on every route's `head()`, defaulting to a single branded static `og:image` (`public/og.png`, 1200×630, generated by a Playwright one-shot — generic persona, no real identifiers) + a hand-authored SVG favicon. The owner's headshot, when supplied, becomes the `/work` + a candidate-branded `og:image`. The **dynamic per-run** simulator-share preview (the run's company/role in `og:title` + a per-run `og:image`) is deferred to the Phase 9/10 deploy work — it needs a route loader (server-fetch the persisted run for SSR `head()`) + a Worker-side dynamic-OG-image endpoint.
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

> **Build note (STRATEGY §24.71 / Phase 9.4b — basics-in, agent-composes-page):** the owner doesn't hand-fill every variable above. The elevated flow collects the **basics** (name, contact/links, target roles, comp) + a **natural master resume**, then the agent **composes the `/work` page** from them — choosing which sections present well, wording the prose, applying a minimum bar, and omitting under-sourced sections (§10/§12 placeholder UX covers the gaps). It composes from real material only (never invents history) and the page carries a provenance marker. The composed page persists as `candidate_profile.work_profile_json` via the `set_work_profile` MCP tool; the owner approves a preview and refines in natural language ("tighten the bio," "drop that project") → recompose. So the "fill these 11 variables" checklist becomes "give the agent the basics and approve the page it builds."

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

## 13. Responsive & mobile

The portal is **phone-primary responsive**, not desktop-only. A page that overflows or hides controls behind un-tappable targets on a phone reads as *unfinished* to anyone — so good mobile behavior is table-stakes, independent of who's looking. The tie-breaker persona, where a layout call trades phone polish against desktop, is the **recruiter on a phone** (a plausible first-touch context): on the surfaces a recruiter hits first, the phone wins.

**Target & breakpoint.** Design canonically for **~390px** (modern iPhone/Android), verified down to **320px** (iPhone SE) and **360px** (common Android). The phone/desktop divide is Tailwind's **`md` (768px)**, applied mobile-first: base styles are the phone treatment, `md:` restores the desktop layout. (The header may collapse at a lower threshold if the full nav row still fits comfortably at tablet widths — tuned in build.) Out of scope: a **tablet-specific tier** (the phone + desktop treatments cover the middle) and a **native app** (STRATEGY Part V) — responsive web is the plan.

**Recon-grounded (2026-06-03 — all 8 routes driven at 390px + spot-checked at 320px on `dev:mock` via the Playwright MCP, *before* this spec was written).** Every page already stacks into a clean single column with **zero content overflow** — Tailwind's responsive utilities do most of the work. There is exactly **one universal break** (the top nav), plus **two ops-page judgment calls** and minor polish. Mobile is therefore a focused pass, not a responsive rebuild.

**The responsive contract, surface by surface:**

| Surface | Behavior below `md` |
|---|---|
| **Top nav (§8.1)** | *The one universal break.* The horizontal link row (`Live · Job Pipeline · Architecture · Simulator · Work · Contact` + wordmark > 431px) overflows every page → horizontal scroll, the last link clipped, the wordmark wrapped. Collapses to a **hamburger** (below). |
| `/` home · `/work` · `/contact` · `/simulator` (input) · `/simulator/results/$id` | **Already correct** — single-column stack; forms, cards, and chip rows reflow; fits to 320px. No change beyond the shared header. |
| `/architecture` (§5.5) | The SVG **scales to fit** the width (whole-system-at-a-glance — the point of an architecture diagram — is preserved). Detail comes from **tapping a node** (the §8.5 node modal, rendered as a **bottom-sheet** on phones), not from reading the shrunk labels. **Pinch-zoom is scoped to the diagram itself** (STRATEGY §24.64): two fingers on the diagram zoom/pan only the map (clamped 1–3×, a “reset” chip restores 1× and page scrolling); the rest of the page never zooms. Native page pinch remains untouched everywhere else. |
| `/live` (§5.2) | **Trace-first.** The live trace stream leads (the "agent working now" wow is immediately visible, not buried); the stat panels (system status, sessions, container pool, telemetry, cost, recent outcomes) stack below. **All panels kept** — honest and complete. On a phone each entry stacks: a compact metadata row (`time · agent · ◆`) with the **`[ref]` + message on their own full-width line below** (the ref leads the sentence — no orphaned-ref raggedness); the desktop single-row terminal layout is restored at `sm+`. The message **wraps fully on `/live`** (the readable log); the home live-activity ticker (§5.1) **clamps it to 2 lines** (`…` if longer) so one long action can't swallow the teaser. |
| `/pipeline` (§5.4) | The board's desktop horse-race flattens to a **vertical stack** of stage sections (top-to-bottom = progress toward an offer); **zero-count stages collapse to a slim row** so empty stages don't each eat a screen. |
| `/kit` (§5.9) | Single-column document: the TOC rail becomes a **horizontal chip row pinned under the masthead** (scrollable, sealed `⊘` chips included); Part 2's pocket card goes full-width; redaction bars + captions reflow naturally. No horizontal overflow at 320px. |

**The hamburger (§8.1).** Below **`sm`** (640px — where the full row no longer fits; tablets keep it) the header keeps the wordmark left and shows a hamburger button right; tapping it opens a labeled **disclosure** menu carrying the six nav links. It's built as a disclosure — `aria-expanded` / `aria-controls`, and Escape / outside-click / link-tap all close it — **not** a modal: a nav menu doesn't trap focus or inert the page (the **§8.5** contract is for the modal overlays). Each menu link is a ≥44px tap target. The header stays sticky; at `sm+` the full horizontal row returns unchanged.

**Tap targets.** Interactive controls meet **≥44px** on phones (WCAG 2.5.5 / Apple HIG): the hamburger, the `/architecture` nodes, the `/pipeline` cards, the `/live` trace filter chips. The architecture nodes also carry a mobile-only **"tap a node for detail"** cue (there's no hover affordance on touch).

**Decisions (owner-delegated, recon-grounded — the alternatives and why-not):**
- **`/architecture` SVG → scale-to-fit + tap-for-detail.** Not *min-width + horizontal pan* (a two-axis scroll trap, and it loses the at-a-glance gestalt), and not a *separate mobile diagram* (two representations to keep in sync). The readable detail already lives in the node modals we built (§8.5). *Escape hatch:* a modest min-width pan if build-time review finds the labels too cramped.
- **`/live` → trace-first, keep all panels.** Not *collapsible stat panels* (hides info + adds interaction cost a skimming visitor doesn't want) and not *current order* (buries the centerpiece below four panels). The fix is purely ordering. *Escape hatch:* condense the stat panels if the scroll proves too long.
- **`/pipeline` → vertical stack + compact empties.** Not *horizontal scroll-snap* (off-screen columns are a discoverability anti-pattern and fight the page's vertical scroll). The race metaphor is a desktop affordance; readability wins on the phone.

**Carried over unchanged:** the reduced-motion guarantee (§3.5) and the dialog focus/a11y contract (§8.5) apply on mobile as on desktop; the bottom-sheet node modal honors both.

**Standing mobile rules (added per STRATEGY §24.58, learned from the /pipeline phone defects):**
- **Every grid declares its column template at the base breakpoint** (`grid-cols-1`, not bare `grid`): an un-templated implicit track sizes to content *min-width*, and a `truncate`d element still contributes its full nowrap line as min-content — so one long real-world string blows the page out sideways while short fixture data keeps CI green. Pair the rule with at least one real-shaped long string in the deterministic seeds.
- **Open dialogs scroll-lock the body** (in the shared `useDialog`, so every dialog inherits it): `inert` stops interaction but not scroll-chaining; without the lock, touch scroll moves the page behind the open drawer.

**Standing layout-stability rule (added per STRATEGY §24.62, learned on desktop):**
- **The root reserves its scrollbar gutter** (`html { scrollbar-gutter: stable }`): on classic-scrollbar platforms the root scrollbar comes and goes with page height and with `useDialog`'s scroll-lock, and every centered `max-w-*` layout shifts by half a scrollbar width when it does — the header wobbles between pages and content jumps sideways under opening dialogs. The reserved gutter makes both impossible; overlay-scrollbar platforms are unaffected.

---

## 14. Open questions

1. **Should `/live` be discoverable without clicking through?** Alternative: render a "preview pane" of `/live` as a viewport on `/` for visitors who don't click. Risk: dilutes the apple-clean hero. Recommendation: keep landing clean, but add a single ~120px-tall live ticker between viewports 2 and 3 as a teaser.

2. **Anonymization for hired companies that haven't agreed:** What's the policy if the candidate signs an offer with a company that wants to keep the hire quiet for now? Recommendation: default `public_state = 'partial'` for any offer/hire until explicit reveal.

3. **Recruiter Simulator scope:** Do we run `resume-tailor` only, or `resume-tailor + outreach-drafter` (full pitch)? Two skills × ~$0.04/run vs one × ~$0.02. Recommendation: full pitch — that's the wow moment.

4. **Cost cap on simulator:** A pessimistic max of $5/day in simulator spend (≈100 runs) feels right. Above that, simulator goes read-only with a "back tomorrow" message. Confirm.

5. **PDF resume generation:** Server-side generation (puppeteer in the host process) or static commit-time artifact? Recommendation: server-side, signals "live system."

6. **Mobile experience for `/live`:** Dense ops UI doesn't translate. Options: (a) hide non-essential panels on mobile and show a vertically-stacked subset, (b) render `/live` as a horizontal carousel of panels, (c) redirect mobile to `/` with a "best on desktop" note. Recommendation: (a) — vertically stacked subset. *(**Resolved** — §13 + STRATEGY §24.37, 2026-06-03. Recon found `/live` already stacks cleanly with no overflow, so the canonical answer evolved past "hide a subset" to **trace-first ordering, all panels kept**; the broader mobile strategy is now §13.)*

7. **Anonymous analytics for the portal:** Cloudflare Web Analytics or none? Recommendation: Cloudflare, since it's privacy-respecting and free with the Workers deployment.

8. **Accessibility:** WCAG AA target. The dense ops register needs careful attention to contrast ratios + ARIA labels for the live stream + keyboard navigation through filter chips. Recommendation: explicit pass during implementation; not a blocker for v1. *(Partially closed: every route is axe-zero-violation in E2E; modal/drawer focus-trapping + dialog a11y landed in STRATEGY §24.36 36.2 — see §8.5.)*

---

## 15. Out of scope (deliberately)

- A blog / writing CMS — link out to wherever the candidate writes.
- A general portfolio (non-career-pilot) — `/work` covers the resume case, but career-pilot is the centerpiece.
- Multi-user / SaaS-ifying career-pilot. The portal showcases a single user. If a recruiter wants the same for their candidate pool, that's a future product, not v1.
- Internationalization. English only.
- Dark/light mode toggle. Dark only.
- A "live chat with the agent" experience for visitors. The simulator covers this with bounded scope.

---

## 16. Next step

After sign-off on this spec, the next deliverable is `STRATEGY.md`:
- Branch structure (where this lives relative to NanoClaw fork)
- Backend module layout (portal module, sanitization, public_audit_trail, sandbox agent group, portal channel adapter)
- Career-pilot agent group definition (CLAUDE.md, skills, subagent design via Claude Agent SDK `agents:` option)
- Portkey + OneCLI credential layout
- Infrastructure (GCP e2-medium, Cloudflare, deploy paths)
- Milestone plan from "fork NanoClaw" to "portal live with real data"
