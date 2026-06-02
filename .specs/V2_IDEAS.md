# V2 Ideas — Deferred for Later

Things we explicitly choose NOT to build in v1. Tracked here so they aren't lost.

The bar for v1: hire.example.com goes live, `LIVE_MODE=true`, the candidate uses it for their actual job search. Everything not directly serving that bar is here.

---

## 1. Public visitor bot (Telegram or Discord)

Originally specced as an alternative contact path on `/contact`. The web simulator covers the "let me talk to your agent" use case; a public DM-able bot would let visitors have multi-turn conversations with a sandbox version of the orchestrator.

**Why deferred:** Adds abuse surface, requires another sandbox isolation level, and the simulator already proves "the system works" without the operational overhead.

**Reactivate when:** Portal has traction and visitor demand for deeper interaction is clear. Half-day of work via NanoClaw's `/add-telegram` or `/add-discord` skill into a separate sandbox agent group.

---

## 2. Multi-user / SaaS-ification

The repo is already generic-by-design (any dev can fork and populate their own profile). A natural v2 is hosting it as a multi-tenant service.

**Why deferred:** Goal is to land *the candidate's* dream job, not build a product. Productizing later (after a successful hire) makes a much better v2 story.

**Reactivate when:** the candidate has landed and wants this as their next thing.

---

## 3. Discord channel for the candidate (owner)

`/add-discord` installer adds a Discord channel adapter. Wired to the same `career-pilot` agent group (or per-thread for per-company sessions), it gives a richer UI than Telegram (embeds, modals, buttons).

**Why deferred:** Telegram-only covers v1. Discord adds richer surface but is a nice-to-have, not a must.

**Reactivate when:** v1 is stable; ~half-day of work.

---

## 4. Auto-apply

The agent fills out job application forms autonomously and submits. Tempting, but:

**Why deliberately NOT v1, possibly never:** Job applications are high-stakes external commitments. The "agent applied to 200 jobs in your name overnight" failure mode is catastrophic. Always human-in-the-loop for application submission. We may add "auto-fill draft for human to review and submit" later, but the agent doesn't press "submit" itself.

---

## 5. TanStack Start version upkeep

~~We pinned an RC.~~ **Resolved:** v1.0 shipped (2026-03); Phase 6 scaffolds directly on v1 (STRATEGY.md §24.23). Remaining item is ongoing version upkeep, not a migration.

**Reactivate when:** a later v1 minor/major lands with features we want; re-evaluate the pin at end of Phase 7 per Open Question §3.

---

## 6. Custom-domain email (Google Workspace)

v1 uses a free dedicated Gmail (e.g., `jane-doe.career@gmail.com`). v2 upgrade to `jane@hire.example.com` via Google Workspace ($6/mo) — looks more polished on outbound recruiter emails.

**Reactivate when:** v1 is live and the candidate wants the brand polish.

---

## 7. Voice interface

Telegram voice messages → STT → agent → TTS → reply. Could be a fun differentiator but adds surface, cost, and infrastructure complexity.

**Reactivate when:** v1 is stable and the candidate wants a "use it while walking" experience.

---

## 8. Sandbox account-required gating

If the portal goes viral and the layered abuse protection ($5/day cap, IP/DO rate limits, Turnstile) isn't enough, gate sandbox access behind a magic-link email or social login.

**Reactivate when:** sandbox abuse becomes a recurring problem; current design's $5/day cap is a soft ceiling we can live with.

---

## 9. Per-thread Discord sessions per company

If the candidate wires Discord later (item 3), one configuration is `session_mode: 'per-thread'` so each Discord thread → its own NanoClaw session → its own per-company memory. Nice when actively interviewing with many companies.

**Reactivate when:** Discord is in and the candidate has 5+ simultaneous interview processes.

---

## 10. Custom WAF rule (paid Cloudflare)

Free Cloudflare gives 1 WAF custom rule + 1 rate-limit rule. v1 spends them on `/api/sandbox/*` protection. v2 could upgrade to a paid plan for richer WAF rules across `/contact`, `/api/activity/stream`, etc.

**Reactivate when:** observed abuse patterns justify $20/mo Cloudflare Pro.

---

## 11. Owner-private admin TUI

Beyond `ncl`'s admin CLI and the Telegram interface, a richer TUI for ops would be nice for cost dashboards, session inspection, log tailing. Could be built on Ink or Blessed.

**Reactivate when:** owner observability needs outgrow what's in PORTAL.md and Telegram.

---

## 12. Auto-onboarded research cache per industry

Beyond per-company `research-company` cache, build a per-industry knowledge base (e.g., "Series-B AI infra startup hiring patterns") that primes the orchestrator's context for new applications.

**Reactivate when:** the candidate has accumulated learnings across 20+ applications and the pattern is clear.

---

## 13. Migration to Managed Agents (Anthropic's hosted product)

We chose the Agent SDK (in-process library) over Managed Agents (Anthropic-hosted REST). If session state grows large, Managed Agents' hosted infrastructure may be more cost-effective than self-hosting. The Agent SDK overview docs explicitly mention this as a "prototype here, migrate to Managed Agents in production" pattern.

**Reactivate when:** session storage / container lifecycle costs justify the migration.

---

## 14. LinkedIn DM-based outreach

Considered for Phase 2.3 (`draft-outreach`) as an alternative channel to Gmail. The orchestrator drafts a cold InMail-style message via the same `draft-outreach` chain (research-company → draft-outreach) and pushes it to LinkedIn as a saved draft or direct DM.

**Why deferred indefinitely:** LinkedIn does not expose an unrestricted DM-send API for arbitrary users.
- The official **LinkedIn API** (Marketing API, Sales Navigator API) is partner-tier only and covers content posting + ATS integrations, not cold outreach to arbitrary individuals.
- **InMail** requires Sales Navigator or Recruiter seats and is not programmatically automatable through any public surface.
- **Unofficial scrapers** (Phantombuster, Apify-style cookie-session impersonators) violate LinkedIn's ToS, risk account bans, and would put the candidate's primary professional surface at risk — unacceptable cost/benefit for v1.

Gmail covers the cold-outreach channel for v1 with a real, official, low-risk API.

**Reactivate when:** LinkedIn ships an official DM-send endpoint on their public REST surface (and only then). No expected timeline.

---

## 15. Killer-match "signals" feed on the portal

Surface the orchestrator's *judgment* publicly: a `/live` feed of why a discovered role is a strong fit, sourced from `job_leads.rules_score` + `rules_score_reasons` (and `llm_score_reasons`) — e.g. *"94/100 at [REDACTED]: matches your Kubernetes + multi-region experience, comp above floor, remote-OK."* A stronger "the agent has taste" signal than raw activity. The killer-match alert pipeline (STRATEGY.md §24.7) already computes these privately.

**Why deferred:** No PORTAL.md panel specs it (charter brainstorm, not a spec'd surface). More consequentially, it has an **unspecced anonymization gap**: §9's privacy model is per-*application* (`public_state` / `obfuscated_label` live on `applications`); `job_leads` has no obfuscation columns at all. A public lead-signals feed needs a fresh privacy decision — most leads are companies the candidate never engaged, and "agent found a 94 match at &lt;Company&gt;" publishes a match the candidate didn't choose to surface. Building backend before that product/privacy question is answered is speculative.

**Reactivate when:** the portal is live and there's a decision that a signals feed earns a PORTAL panel — at which point spec the lead-anonymization model first (obfuscation for unengaged leads), then add a sanitized projection + best-effort hook (the same pattern as `public_funnel_view`). The raw data is already captured, so it's a small add on the established pattern, not a big backend change.
