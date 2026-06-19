# Phase 5 Prep Audit — Findings

**Date:** 2026-05-29 · **HEAD:** `16539da` · **Branch:** `nanoclaw-rebuild`
**Charter:** `memory/phase5_prep_audit.md` (dimensions A–E)
**Method:** read tracked source directly; ripgrep respects `.gitignore` (load-bearing — see "Charter corrections" below).
**Status: cleanup EXECUTED 2026-05-29** — Tier 1 + both chosen Tier 2 items shipped in commits `14ac21b`..`c53147e`. Kept as the audit-of-record; the cleanup plan at the bottom notes what's done.

---

## TL;DR

The codebase is in good shape — *organized*, not chaotic. The spec-driven discipline held: tracked source is the single source of truth, deviations are logged, tests are green. No scary dead code, no lost work, no silent rot.

The real findings cluster into **three themes**:

1. **The four-tier config model is partly fictional.** CLAUDE.md rule #5 and STRATEGY §20 promise a unified `getConfig(key, fallback?)` host helper reading `env > preferences > defaults.json`. It **does not exist**. Reality: ~6 bespoke per-feature preference readers + inline `SELECT value FROM preferences` queries, each with a hardcoded fallback, and **`config/defaults.json` has zero runtime readers** (its only seeder, `setup-local.ts`, is an unimplemented stub). This is the single biggest spec↔code gap and it matters for Phase 5 (the portal backend will need to read config too).

2. **Stale spec pointers + one tracked dead-stub.** The MCP tool catalog drifted (specs say "14 tools in `groups/.../agent-runner-src/`"; reality is **20 domain tools in `container/agent-runner/src/`**), a 44-line dead stub directory still exists at the old path, the subagent count is wrong ("Five" → six), and a STRATEGY open question (Q#7) was silently *resolved in code* but never closed.

3. **Test fragility is endemic, not isolated.** The leaked-poll-loop flaw I patched on one test (`abort()` doesn't stop `runPollLoop`'s `while(true)`) applies to **19 uses** of the same helper in `integration.test.ts`.

The **encouraging** Phase-5 result: the portal's **anonymization backend is already built and tested** — the part the charter feared might block us. `public_state`, `obfuscated_label`, the assignment function (`nextObfuscatedLabel`/`deriveIndustry`), and the sanitization replacement pipeline all exist with coverage. Phase 5 is "expose the built backend via API/SSE," not "figure out anonymization."

---

## Dimension A — Dead code / orphans

| # | Finding | Severity | Disposition |
|---|---|---|---|
| A1 | **`config/defaults.json` has zero runtime readers.** Only `lead-rules-score.ts` *mentions* it (in a comment). Its declared seeder `setup-local.ts` is a `not yet implemented` stub; `setup-test.ts` doesn't seed it; migration 104 only creates the empty table. So in dev/test the `preferences`/`system_modes` tables are **never seeded** and every read falls through to a hardcoded fallback. | High | See A2/B1/C1 — wire it or de-scope (decision needed). |
| A2 | **Three Phase-0 stub scripts** throw `not yet implemented`: `setup-local.ts`, `reset-dev.ts`, `sync-shared-skills.ts`. None are wired to `package.json` scripts (`setup:local`/`reset:dev` don't exist). | Low | **Keep** (planned Phase-1/2 entry points) but fix the misleading docstrings that claim they *already* seed. |
| A3 | **Tracked dead-stub directory:** `groups/career-pilot/agent-runner-src/mcp-tools/index.ts` — 44 lines, commented-out `createSdkMcpServer`, the *only* tracked file in that whole tree. The abandoned original tool location; real code is `container/agent-runner/src/mcp-tools/`. Specs still point here (see C4). | Medium | **Delete** the dir + fix the spec paths together. |
| A4 | Upstream NanoClaw scripts (`seed-discord`, `test-v2-*`, `init-*-agent`, `delete-cli-agent`, `run-migrations`) look unused-by-us but are upstream infra. | — | **Out of scope** (infra-first discipline — don't delete upstream). |
| A5 | `groups/career-pilot/memory/` — untracked agent-generated test detritus; `setup-test.ts --reset` doesn't wipe it. | Trivial | gitignore it or have `--reset` clean it. |

## Dimension B — Simplification / consolidation

| # | Finding | Disposition |
|---|---|---|
| B1 | **No unified config helper.** ~6 bespoke readers (`readKillerMatchPreferences`, `readFunnelCuratorPreferences`, `readBriefingPreferences`, `readCloseDetectionPreferences`, `readKillerMatchActionPrefs`, `readBoolPref`) + inline `SELECT value FROM preferences WHERE key = ?` queries scattered across `actions.ts`, `job-lead-actions.ts`, and the four `*-bootstrap.ts` files. Each duplicates the read-with-fallback pattern. | **Decision needed** (see C1): build the spec'd `getConfig(key, fallback?)` and migrate the readers to it, *or* de-scope the four-tier model in the spec to match reality. |
| B2 | **Subagent "drift" is a non-issue.** Single tracked source `groups/_shared-subagents/` (+ `_shared/subagent-preamble.md`); the on-disk `groups/*/.claude/agents/*.md` are git-ignored *materializations*. The owner/sandbox byte-difference I saw is stale materialized output (the `(PORTAL.md §5.2)` spec-ref lives only in an ignored copy — the **tracked source is clean**). | **No action.** Correct the charter's assumption. |
| B3 | **persona.md is 900 lines.** The deferred persona-vs-skill refactor (`decision-persona-skill-refactor`, revisit-at-Phase-3) is overdue for re-evaluation now that proactive flows (daily-briefing, killer-match, funnel-curator, close-detection) multiplied. | **Decision needed** — defer again, trim, or adopt SDK Skill lazy-load. |
| B4 | **Magic-number tension.** The hardcoded fallbacks in the readers (e.g. `DEFAULT_CRON_EXPR`, score floors) duplicate `defaults.json` values. Resolves automatically if B1/C1 builds `getConfig` (defaults.json becomes the single source). | Folds into B1. |
| B5 | **The 4 upstream deviations** (Δ1 composer `.claude-host-fragments` ext, Δ2 pnpm-workspace, Δ3 Windows named-pipe IPC, Δ4 sendAction readonly-race patch) — `/update-nanoclaw` friction. Not deeply re-audited this pass; the readonly-race patch should be checked against upstream issue status. | **Defer** to a focused `/update-nanoclaw`-prep pass (not Phase-5-blocking). |

## Dimension C — Spec↔code drift

| # | Finding | Fix |
|---|---|---|
| C1 | **`getConfig(key, fallback?)` doesn't exist** but CLAUDE.md rule #5 + STRATEGY §20 (lines ~1002, ~1173) describe it as the load-bearing config mechanism. (Root of B1.) | Build it, or rewrite the spec to describe the actual scattered-reader reality. **Decision needed.** |
| C2 | **Subagent count wrong.** CLAUDE.md locked-decisions table says "Subagents: **Five**" — there are **six** (owner group: research-company, tailor-resume, draft-outreach, prep-interview, scrape-jobs, **+ funnel-curator** added Phase 4). Sandbox correctly has the first three. | Update CLAUDE.md to six; note funnel-curator's read+write-via-`persist_funnel_state` shape. |
| C3 | **MCP tool catalog count.** `AGENT_SDK_PATTERNS.md §7` says "**All 14** in-process tools." Actual registered: **20** domain tools (`career-pilot.ts`:7, `scrape-jobs.ts`:8, `funnel-curator.ts`:5). Four originally-planned tools landed elsewhere by design (`analyze_jd`→`jd_analyzed` patch field; `sanitize_text`→host-side `portal/sanitizer.ts`; `parse_email`→funnel-curator subagent; `save_outreach_draft`→`create_gmail_draft`). | ✅ done — recounted to 20 + reconciled planned-vs-built in §7. |
| C4 | **MCP tool path + pattern drift.** `AGENT_SDK_PATTERNS.md §7` (lines 364–411) still shows the `createSdkMcpServer` pattern at `groups/career-pilot/agent-runner-src/mcp-tools/`. STRATEGY §6 (line 586) already *corrected* this to the `registerTools` self-registration in `container/agent-runner/src/mcp-tools/` — so the two spec docs disagree, and §7 points at the A3 dead stub. | Update AGENT_SDK_PATTERNS §7 to match STRATEGY §6 + real path; delete the stub (A3). |
| C5 | **STRATEGY Part VI Q#7 (obfuscated_label assignment) is resolved in code but open in spec.** `actions.ts:431` `nextObfuscatedLabel(industry)` + `deriveIndustry()` (from `jd_analyzed.role_category`, fallback `misc`) + sequential per-industry letter; covered by `actions.test.ts` + `actions.integration.test.ts`. | Close Q#7 in STRATEGY; the charter's "blocks portal anonymization?" worry is **unfounded**. |
| C6 | `defaults.json:2` + migration 104 docstring claim seeding by `setup-local.ts` / `pnpm run migrations` — neither is wired (A2). | Fix the two comments to state the real (currently-unwired) status. |

## Dimension D — Test health

| # | Finding | Disposition |
|---|---|---|
| D1 | **Leaked-poll-loop fragility is endemic.** `runPollLoop`/`runPollLoopWithTimeout` is used **19×** in `container/agent-runner/src/integration.test.ts`. The flaw I patched on one test (abort rejects only the race wrapper, not `runPollLoop`'s `while(true)`, so leaked loops contend on the shared synchronous SQLite DB) applies to all of them — borderline-flaky by construction. | **Decision needed** — add a real cancellation hook to `runPollLoop` (clean fix, slightly invasive) vs. harden the test helper's timeout windows broadly (cheap, treats symptom). |
| D2 | The 5 Windows-excluded tests in `vitest.config.ts` are upstream platform quirks (shell-quoting, EBUSY on SQLite rm, symlink-priv), well-documented, CI-deferred to Phase 8 on Linux. | **No action** — leave as-is. |

## Dimension E — PORTAL.md revisit (forward-looking)

PORTAL.md (§§1–15, ~1244 lines) re-read against the backend reality built through Phase 4.

**Does the data model support what the portal promised?** Largely **yes**, and more than the charter assumed:
- **Anonymization (§9):** fully built (C5) — `applications.public_state`, `obfuscated_label`, assignment fn, alias handling, sanitizer replacement, `public_audit_trail`, migrations 100/102/122. **Not a blocker.**
- **Sanitization pipeline (§9 / §11):** `portal/sanitizer.ts` (143) + `portal/public-audit.ts` (233) implement the regex + company-name passes + mirror writer (the Phase-4 §24.10 observer). The optional async LLM pass exists per `sanitization_*` preferences.
- **Feedback loops (§6.7):** funnel-curator + killer-match + `public_audit_trail` give richer pipeline state than the original plan anticipated.

**The Phase-5 surface that is (correctly) still stubbed** — these tiny `portal/` files are *expected* Phase-5 work, **not junk**: `api.ts` (26), `sse-broadcaster.ts` (15), `simulator.ts` (19), `contact-relay.ts` (20), `system-modes.ts` (17), `portkey-analytics.ts` (16), `kill-switch.ts` (24). They map 1:1 to the 10 API surfaces in PORTAL §11 (`/api/funnel`, `/api/activity[+stream]`, `/api/telemetry`, `/api/architecture`, `/api/simulator[+stream+results]`, `/api/contact`) plus the required capabilities (portal channel adapter, Portkey analytics proxy, rate limiting). The observer + sanitization are done; the rest is Phase 5.

**Enhancements newly ENABLED (cheap now, weren't planned):**
- `public_audit_trail` (with `subagent_progress` category + the `record_progress` trace stream) → a **live anonymized agent-activity timeline** on `/live` is mostly a query away.
- killer-match `rules_score` + `rules_score_reasons` → a "signals/why-this-fits" feed.
- funnel-curator `narratives[]` + `attention[]` materialized read-model → richer `/funnel` per-company state without recomputation.

**Assumptions to confirm (mostly UX, not backend-blocking):** PORTAL §13 open questions are largely frontend (discoverability ticker, mobile `/live`, analytics, a11y, PDF gen, simulator scope/cost cap). The one backend-touching policy is §13-Q2 / §9-rule-2 (hired-but-quiet company → default `public_state='partial'`) — a sanitizer default, easy.

**Phase 5 scope confirmed:** portal **BACKEND** (SSE/API feeding the frontend). `frontend/` is still a README placeholder; pnpm-workspace must add it when the frontend lands.

---

## Charter corrections (assumptions that were wrong)

- **"Subagent .md files are byte-identical copies — verify no drift"** → moot. They're git-ignored materializations of the single tracked source `groups/_shared-subagents/`. Audit the *source*, not the materialized copies.
- **"obfuscated_label assignment unresolved — blocks portal anonymization"** → resolved in code (C5).
- **"portal/ has ~9 Phase-0 placeholders, some stale"** → they're not stale; they're the legitimately-unbuilt Phase-5 API surface. The genuinely-stale stub is elsewhere: `agent-runner-src/` (A3).

---

## Cleanup plan — EXECUTED 2026-05-29

**Tier 1 — spec/doc reconciliations + dead-stub removal — DONE (`14ac21b`):**
1. ✅ C2 — CLAUDE.md "Five subagents" → six (+ funnel-curator).
2. ✅ C3 + C4 — AGENT_SDK_PATTERNS §7: 14→**20** tools, path → `container/agent-runner/src/mcp-tools/`, `registerTools` note; reconciled the 4 planned-but-relocated tools. Also fixed the STRATEGY repo-tree + group-folder list + VERIFICATION.md.
3. ✅ C5 — closed STRATEGY Part VI Q#7 (assignment is built + deterministic + tested).
4. ✅ C6 + A2 — corrected the seeding docstrings in `defaults.json` + migration 104 (folded into Tier 2b, where they became true).
5. ✅ A3 — deleted the `groups/career-pilot/agent-runner-src/` dead stub.
6. ✅ A5 — gitignored `groups/*/memory/`.

**Tier 2 — decided + DONE:**
- ✅ **D-config (A1/B1/B4/C1) — BUILT** (`2b1fc7a` + `dc75da9`): `getConfig()` four-tier helper (`src/get-config.ts`) + migrated the 6 readers; defaults.json now read at runtime. Behavior-preserving, 200 host tests green, net −94 lines.
- ✅ **D-tests (D1) — cancellation hook** (`c53147e`): optional `AbortSignal` on `runPollLoop`; 144 container tests green; the endemic leak is fixed.
- ⏸ **D-persona (B3) — deferred again** to early Phase 5 (recorded in the persona-refactor decision memory).

**Tier 3 — deferred (not Phase-5-blocking):**
- B5 — focused `/update-nanoclaw`-prep audit of the 4 deviations.

**Status:** all chosen cleanup shipped locally on `nanoclaw-rebuild` (`14ac21b`..`c53147e`); not yet pushed. Phase 5 (portal backend — expose the built backend via SSE/API) is the next major phase.
