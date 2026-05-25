# Career Pilot

An autonomous agentic job-search assistant that the candidate uses to land
their next role. Forkable, generic-by-design — clone, populate your own
candidate profile, run.

**Public showcase portal:** `hire.<DOMAIN>` — a recruiter-facing site driven
by the same agent system running the actual job search.

---

## What this is

A clone-and-customize fork of [NanoClaw v2](https://github.com/nanocoai/nanoclaw)
that wraps the [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/overview)
into a job-search-specific application:

- An owner agent (`career-pilot`) you talk to via Telegram. It researches
  target companies, tailors your resume per role, drafts outreach, preps you
  for interviews, and tracks your funnel — all with you in the loop.
- A public-facing simulator at `hire.<DOMAIN>/simulator` that lets recruiters
  run a sandboxed version of the same agent on their own company + JD.
- A sanitized public dashboard (`hire.<DOMAIN>/live`, `/funnel`,
  `/architecture`) showing the system at work without leaking private
  application details.

The whole stack is configuration-driven (zero magic numbers), has explicit
kill switches with documented recovery, and supports a `LIVE_MODE=false`
shadow-run buffer for soft-launching before any real outreach goes out.

## Status

Pre-Phase-0. The architecture specs are locked; the actual code-on-disk fork
of NanoClaw is in progress.

See `.specs/` for the full architecture:

| Doc | What it covers |
|---|---|
| `.specs/PORTAL.md` | Frontend UX specification (read first) |
| `.specs/STRATEGY.md` | Backend, infra, delivery plan |
| `.specs/AGENT_SDK_PATTERNS.md` | Claude Agent SDK canonical patterns |
| `.specs/CLOUDFLARE_PATTERNS.md` | Cloudflare protection patterns |
| `.specs/RECOVERY.md` | Operator manual for kill switches + recovery |
| `.specs/V2_IDEAS.md` | Deferred features |

`CLAUDE.md` orients a fresh Claude Code session to the repo.

## Forking for your own job search

Career Pilot is meant to be forkable. After cloning:

1. Populate `candidate_profile` in the dev DB with your own bio, master
   resume, target roles, social URLs — via the Telegram onboarding flow.
2. Configure `.env` from `.env.example` (Portkey, OneCLI, Google OAuth,
   Cloudflare, Telegram).
3. Run `pnpm setup` (idempotent — safe to re-run on either of your machines).
4. Deploy to a GCP `e2-medium` VM via the included Terraform config.

The system is designed for one candidate at a time. Multi-tenant
SaaS-ification is on the deferred list (`.specs/V2_IDEAS.md` §2).

## License

NanoClaw upstream code: MIT (see `docs/upstream-readme.md` and `LICENSE`).
Career-pilot-specific additions: MIT.

---

*This README is generic-by-design. Personal candidate identifiers live in
gitignored `persona.local.md` and the `candidate_profile` table, never in
this file.*
