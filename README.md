# Career Pilot

An autonomous, agentic job-search assistant the candidate uses to land their
next role — and a public showcase that proves it's real. Forkable,
generic-by-design: clone, populate your own candidate profile, run.

**Public showcase portal:** `hire.<DOMAIN>` — a recruiter-facing site driven
by the same agent system running the actual job search.

---

## What this is

A clone-and-customize fork of [NanoClaw v2](https://github.com/nanocoai/nanoclaw)
that wraps the [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/overview)
into a job-search-specific application:

- **An owner agent** (`career-pilot`) you talk to over Telegram. It researches
  target companies, tailors your resume per role, drafts outreach (reversible
  Gmail drafts), builds mock-interview kits, and keeps your pipeline current —
  all with you in the loop.
- **A public sandbox** at `hire.<DOMAIN>/watch` ("Watch it work") that lets a
  recruiter run a budget-capped, isolated version of the same agent on their
  own company + job description.
- **A sanitized public dashboard** (`/dashboard`, `/pipeline`, `/architecture`)
  showing the system at work — live LLM spend, the anonymized application
  pipeline, and the system map — without leaking private application details.

The whole stack is configuration-driven (zero magic numbers), has explicit
kill switches with documented recovery, and supports a `LIVE_MODE=false`
shadow-run buffer for soft-launching before any real outreach goes out.

## Status

**Phase 9.7 — production-cutover prep.** The full system (owner agent,
showcase portal, sandboxed simulator, and the six subagents) is **built and
running on a Cloudflare-Access-gated dev environment**. The work in flight is
the first public production release: the cutover runbook plus dev-side
hardening. See `.specs/PROD_CUTOVER.md` and `STRATEGY.md §24.136`.

See `.specs/` for the full architecture:

| Doc | What it covers |
|---|---|
| `.specs/PORTAL.md` | Frontend UX specification (read first) |
| `.specs/STRATEGY.md` | Backend, infra, delivery plan |
| `.specs/AGENT_SDK_PATTERNS.md` | Claude Agent SDK canonical patterns |
| `.specs/CLOUDFLARE_PATTERNS.md` | Cloudflare protection patterns |
| `.specs/NANOCLAW_INTERNALS.md` | How upstream NanoClaw actually works |
| `.specs/THREAT_MODEL.md` | Public-surface threat model + hardening |
| `.specs/PROD_CUTOVER.md` | Operator runbook for the production cutover |
| `.specs/RECOVERY.md` | Operator manual for kill switches + recovery |
| `.specs/V2_IDEAS.md` | Deferred features |

`CLAUDE.md` orients a fresh Claude Code session to the repo.

## Forking for your own job search

Career Pilot is meant to be forkable. After cloning:

1. Populate `candidate_profile` in the dev DB with your own bio, master
   resume, target roles, and social URLs — via the Telegram onboarding flow.
2. Configure the documented environment variables (Portkey, OneCLI, Google
   OAuth, Cloudflare, Telegram).
3. Run `pnpm setup` (idempotent — safe to re-run).
4. Deploy to a GCP `e2-medium` VM via the included Terraform config +
   `bootstrap-vm.sh`.

The system is designed for one candidate at a time. Multi-tenant
SaaS-ification is on the deferred list (`.specs/V2_IDEAS.md`).

## License

NanoClaw upstream code: MIT (see `docs/upstream-readme.md` and `LICENSE`).
Career-pilot-specific additions: MIT.

---

*This README is generic-by-design. Personal candidate identifiers live in the
`candidate_profile` table (and inject at build/runtime via environment
variables), never in this repo.*
