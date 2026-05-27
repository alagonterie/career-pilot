# scrape-jobs — verification plan

> **Developer-facing.** Not loaded into the agent's runtime context. The
> sibling `scrape-jobs.md` is the runtime spec (composed into the agent's
> system prompt by NanoClaw's per-group composer + our `agents-src/`
> extension). This file is the verification target for that spec — how
> we check that scrape-jobs's actual behavior matches its written
> contract.
>
> Per the project CLAUDE.md runtime-artifact rule: developer-facing DoD
> lives next to the runtime artifact (not inline), so the system prompt
> stays clean of meta-content.

## Definition of done

The runtime contract at `scrape-jobs.md` is the behavioral spec for the
subagent. "Done" means observed behavior matches the spec across the
following checks, in increasing rigor:

### 1. Composer render check (automated, fast)

`pnpm run build` or whatever the composer entry is. After build:

- `groups/career-pilot/.claude/agents/scrape-jobs.md` exists (rendered
  from `agents-src/scrape-jobs.md` + `_shared/subagent-preamble.md`
  include).
- The rendered file's frontmatter contains `tools:
  [mcp__nanoclaw__record_progress, mcp__nanoclaw__fetch_source,
  mcp__nanoclaw__record_job_lead]` — exactly those three, no more.
- The rendered file does NOT exist in `groups/career-pilot-sandbox/`
  (the source isn't in that group → no render → orchestrator can't
  delegate to scrape-jobs from sandbox sessions; defense-in-depth per
  STRATEGY.md §24.5 DoD #10).

### 2. End-to-end wiring (automated — `--flow=scrape-jobs`)

`pnpm test:e2e --flow=scrape-jobs --llm-provider=claude` exercises the
full path: orchestrator dispatches scrape-jobs → subagent calls
`fetch_source` → host fetches Greenhouse/Lever boards → returns
normalized postings → subagent calls `record_job_lead` → host computes
`content_fingerprint` + `rules_score` → row lands in `job_leads` →
orchestrator calls `query_job_leads` to surface results in Pattern B
chat reply.

**`--llm-provider=ollama` is currently broken for this flow.** GLM-4.7-
Flash emits `<Agent .../>` XML text instead of calling the Agent tool;
no dispatch happens. Documented escalation in STRATEGY.md §24.5
empirical iteration log. Long-term fix: parser-side `<Agent>` XML
recovery similar to Phase 2.3 task #87's lenient `<message>` parser.

**v1.0 e2e status: architecturally green, assertion-flaky pending
follow-ups.** All wiring assertions (dispatch, fetch_source called,
query_job_leads called, Pattern B reply) pass consistently. The
`record_job_lead ≥ 1 row` assertion is non-deterministic on live ATS
data — see STRATEGY.md §24.5 open issues #1 (readonly DB intermittent)
+ #3 (narrow test-candidate profile vs live freshest-batch sales
skew). Three remediation paths documented in §24.5. Expected to land
green in a fresh-context session targeting those issues.

Critical subset to check first if the run fails:

- Subagent dispatched at least once (architectural wiring works).
- `fetch_source` returned a non-empty postings array (the seed targets
  are live and reachable).
- No `MCP error -32603: attempt to write a readonly database` error
  in the tool_result stream — that's the open infrastructure issue,
  see §24.5 open issue #1.
- At least one `record_job_lead` call landed (subagent pre-record
  judgment is not 100% drops — see §24.5 open issue #3 if all dropped).
- Recorded leads all have non-null `content_fingerprint` (16-char hex)
  and `rules_score` (0-100). Null in either column = host compute path
  is broken.
- Re-running the flow within the same DB does NOT insert duplicate
  rows — within-source dedup via `ON CONFLICT (source, source_job_id)
  DO UPDATE` is working.

### 3. Pre-record judgment quality (automated assertion within the e2e)

This is the discipline check on the subagent's judgment. The e2e asserts
≥80% of recorded leads have `rules_score > 0`. Failure modes:

- **<80% non-zero scores:** judgment is too generous. The subagent is
  recording postings that have no keyword/comp/location match. Tighten
  the pre-record rules in `scrape-jobs.md` (the "Hard constraints"
  section) or the rules-score formula's thresholds.
- **0 leads recorded total:** judgment is too strict, OR the seed
  list's priority-A boards have nothing matching the candidate's profile
  on the test day. Both are real possibilities — investigate by
  inspecting `fetch_source`'s raw returns vs the pre-record drops.

### 4. Fabrication audit (manual; spot-check after iteration)

For any flagged-suspicious run (the e2e fails on fabrication, or the
operator notices a posting in `job_leads` that "doesn't look real"):

- Pull the JSONL transcript for that scrape-jobs run from
  `data/v2-sessions/<group-id>/transcript.jsonl`.
- For every `record_job_lead` call's `source_job_id`, confirm the same
  `source_job_id` appeared in a `fetch_source` response earlier in the
  same session.
- If any `source_job_id` was recorded without first appearing in a
  fetch response: the subagent fabricated it. Strengthen the
  "NEVER fabricate" constraint in the subagent body and re-run the
  e2e.

This is the load-bearing trust check — the lead pool is downstream
input to every Phase 3+ flow; fabrication compounds.

### 5. Pool hygiene (manual; after 3-5 runs)

After running `--flow=scrape-jobs` 3-5 times across a few days:

- `SELECT COUNT(*) FROM job_leads` should grow monotonically on first
  encounters and stay flat on re-polls (dedup working).
- `SELECT source, COUNT(*) FROM job_leads GROUP BY source` should show
  both `greenhouse` and `lever` entries — if only one source returns
  data over multiple runs, the unreachable source needs investigation.
- `SELECT title FROM job_leads WHERE rules_score = 0` — these are the
  ones the pre-record judgment let through but the host scored as
  zero-match. If many: pre-record judgment too generous.
- `SELECT title FROM job_leads ORDER BY rules_score DESC LIMIT 20` —
  should look like a sane top-20 for the candidate's profile (no
  obvious off-target roles, no obvious duplicates).

### 6. Heartbeat smoke (manual; informal — STRATEGY.md §24.5 DoD #11)

After a scrape run, a follow-up user turn — *"any new AI roles I should
care about?"* — should produce an orchestrator response that calls
`query_job_leads` and surfaces leads from the pool. Validates that the
pool functions as the orchestrator's queryable world-model (the
[[project-job-leads-heartbeat]] framing). Not a hard gate but a useful
sanity check that the pool is queryable in practice, not just in
theory.

## Out of scope for this verification plan

- **LLM scoring quality.** Phase 2.5 doesn't ship LLM scoring — that's
  Phase 3 daily-briefing. The `llm_score` column exists but stays null.
- **Cross-source dedup quality.** Phase 2.5 ships within-source dedup
  only (UNIQUE constraint). SimHash clustering across sources is
  deferred to v1.2 when aggregators land.
- **`fetch_source` rate-limit / ETag-cache correctness.** Those are
  host-side concerns — see (eventual) unit tests in
  `src/scrape-jobs/sources/*.test.ts` and
  `src/modules/career-pilot/fetch-source-action.test.ts`.
- **Persona-side trigger-phrase coverage.** That's in the group-level
  `VERIFICATION.md` §1 voice red-team scenarios — add "refresh job
  leads", "find roles at X", "what's new at <company>" to the next
  red-team pass.

## Trigger to re-run

Re-run this verification plan whenever any of the following changes:

- `scrape-jobs.md` (this subagent's runtime contract) — re-run §1, §2, §3
- Pre-record judgment rules — re-run §3, §4
- The host-side `fetch_source` action or source adapters — re-run §2, §5
- The `record_job_lead` host action or rules-score formula — re-run
  §2 (specifically the `rules_score` null-check and the ≥80% non-zero
  assertion)
- The seed list `groups/career-pilot/data/ats-targets.json` — re-run §2
  (seeds need to be live ATS boards or the e2e gets 0 postings)
- The persona's scrape-jobs sections (subagent list row, chain-rule
  note, worked example) — re-run §2 (orchestrator dispatch wiring) and
  the group-level VERIFICATION.md §1 voice scenarios
