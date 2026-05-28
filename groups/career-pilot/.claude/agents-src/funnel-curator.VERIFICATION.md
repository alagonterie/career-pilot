# funnel-curator — verification plan

> **Developer-facing.** Not loaded into the agent's runtime context. The
> sibling `funnel-curator.md` is the runtime spec (composed into the
> agent's system prompt by NanoClaw's per-group composer + our
> `agents-src/` extension). This file is the verification target for that
> spec — how we check that funnel-curator's actual behavior matches its
> written contract.
>
> Per the project CLAUDE.md runtime-artifact rule: developer-facing DoD
> lives next to the runtime artifact (not inline), so the system prompt
> stays clean of meta-content.

## Definition of done

The runtime contract at `funnel-curator.md` is the behavioral spec for
the subagent. "Done" means observed behavior matches the spec across
the following checks, in increasing rigor:

### 1. Composer render check (automated, fast)

After build / spawn:

- `groups/career-pilot/.claude/agents/funnel-curator.md` exists
  (rendered from `agents-src/funnel-curator.md` + the
  `_shared/subagent-preamble.md` include).
- The rendered file's frontmatter contains exactly the 9 tools listed
  in source: `query_gmail_delta`, `query_calendar_delta`,
  `list_applications`, `get_application`, `query_job_leads`,
  `read_funnel_state`, `read_email_events`, `persist_funnel_state`,
  `record_progress` — no more, no less.
- The rendered file does NOT exist in `groups/career-pilot-sandbox/`
  (the source isn't in that group → no render → orchestrator can't
  delegate to funnel-curator from sandbox; defense-in-depth alongside
  the host-action sandbox guard).
- `model: sonnet` in frontmatter (not haiku, not opus — synthesis
  quality matters; cost still bounded since runs are ~daily).

### 2. End-to-end wiring (automated — `--flow=funnel-curator`)

`pnpm test:e2e --flow=funnel-curator --gmail-fixture=acme-pipeline-multi --calendar-fixture=acme-onsite-tomorrow --llm-provider=claude`
exercises the full path: scheduled-task fires → orchestrator dispatches
funnel-curator → subagent calls `read_funnel_state` (null on first run)
→ calls `query_gmail_delta` (returns fixture messages) +
`query_calendar_delta` (returns fixture event) → calls
`list_applications` + `query_job_leads` → classifies each message,
links to applications, synthesizes narratives + attention list +
suggestions → calls `persist_funnel_state` ONCE → orchestrator reads
the output and emits any same-day-priority highlights (or silent skip
if none).

Critical subset to check first if the run fails:

- Subagent dispatched at least once (architectural wiring works).
- `query_gmail_delta` returned `fixture_mode: true` with 4 messages
  (the canonical pipeline-multi fixture).
- `query_calendar_delta` returned 1 event.
- `persist_funnel_state` called exactly once with a payload that
  parses against the schema.
- `email_events` rows: 4 (one per pipeline message), classifications
  span the pipeline (`application_confirmation`,
  `screen_invite`/`next_round_update`, `take_home_delivery`,
  `onsite_invite`/`next_round_update`).
- `funnel_curator_output` has one row with `cheap_out=false`,
  non-empty narratives + attention.
- `attention` includes at least one item with `priority='same_day'`
  flagging the +26h onsite event.

### 3. Schema-validity check (automated assertion within the e2e)

This is the discipline check on the subagent's output structure.

- Every `new_email_events[i].classification` is one of the 12 enum
  values (host-level validation enforces this; the subagent should
  produce valid values up-front).
- Every `confidence` is in [0, 1].
- Every `narratives[i].timeline_excerpt` is a non-empty array.
- Every `attention[i].priority` is one of `same_day`/`action_owed`/`fyi`.
- Every `suggestions[i].action` is one of the 7 enum values
  (`mark_applied`, `mark_interviewing`, `mark_rejected`, `mark_offer`,
  `create_lead`, `confirm_match`, `draft_followup`).
- `evidence_excerpt` lengths all ≤ 500 chars (host truncates if not;
  log a warning when truncation triggers — subagent should self-cap).

### 4. Calibration sweep (manual; multi-scenario — Layer 5 from spec §24.9)

`pnpm test:e2e --flow=funnel-curator-calibration --llm-provider=claude`
exercises the canonical fixture set with content assertions:

- `acme-applied-confirmation` →  narrative state=`applied`,
  classification `application_confirmation`, confidence ≥ 0.85, linked
  to the seeded Acme application.
- `beta-applied-then-silent` → narrative state=`applied`, attention
  item flagging Beta with `priority='action_owed'` (21d ghosting
  threshold reached on default prefs).
- `noise-newsletter` → classified `noise`, NO narrative change for any
  company mentioned in the digest, NO attention item.
- `cold-recruiter-stripe` → classified `cold_recruiter_outreach`,
  `linked_application_id=null`, suggestion with
  `action='create_lead'`.
- `stripe-screen-invite` → classified `screen_invite`, narrative
  state advances toward `screening` (or remains there if already), no
  ghosting attention.
- `acme-pipeline-multi` + `acme-onsite-tomorrow` → multi-stage
  timeline excerpt with at least 3 events, same-day attention for the
  onsite.

Run this manually whenever the subagent prompt or output schema
changes. Cost: ~6 × ~$0.30 = ~$2/sweep. Not gated on every CI tick.

### 5. Cheap-out path (automated; included in e2e)

A second `--flow=funnel-curator` run *immediately* after a successful
first run (same fixtures, no new state) should:

- Read the prior `funnel_curator_output` (the one we just wrote).
- See zero new messages from `query_gmail_delta` (fixtures are
  deterministic; nothing new since last run).
- See zero new events from `query_calendar_delta`.
- Determine no ghosting transitions are due.
- Call `persist_funnel_state` with `cheap_out=true`, empty
  `new_email_events`/`narratives`/`attention`/`suggestions`.
- `cost_usd` ≤ $0.05 for this cheap-out run.

(This assumes the fixtures don't shift relative dates enough to
cross a threshold between the two runs; if they do, the cheap-out
won't trigger — that's expected.)

### 6. Sandbox isolation (automated — DoD #12 from spec)

- Spawning a `career-pilot-sandbox` session does NOT schedule
  funnel-curator (bootstrap is owner-group-only — verified by the
  bootstrap unit test + the absence of `agents-src/funnel-curator.md`
  in the sandbox group).
- Calling `mcp__nanoclaw__query_gmail_delta` from a sandbox session
  returns a `FORBIDDEN`-shaped error from the host action (verified by
  `funnel-actions.integration.test.ts`).

### 7. Cost / quota envelope (manual; after 5+ runs)

After 5+ real (non-fixture) runs against the candidate's actual inbox:

- Per-run `cost_usd` is bounded — typical day ~$0.20-0.50 (Sonnet on
  delta-sized inputs); first-run backfill ~$2-5; cheap-out runs
  ≤ $0.05. Spikes above $1 outside of backfill warrant investigation.
- Gmail API quota usage is far under cap. ~50 messages/day × 20 units
  for `messages.get` = ~1000 units/day, with 80M/day cap.
- No `Migration applied` log line for any session post-121
  (migration runs once per DB; integration tests reset to fresh DB).

## Out of scope for this verification plan

- **Real Gmail/Calendar OAuth integration.** The host actions return
  `NOT_IMPLEMENTED` when the `*_FIXTURE` env is unset. Real wiring is
  a post-DoD follow-up (the OneCLI Gmail scope is already granted by
  the `add-gmail-tool` skill; calendar by `add-gcal-tool` — the
  remaining work is just wiring the Google REST clients in the host
  actions).
- **Briefing / on-demand consumer integration.** Verified separately
  by component-7 tests (the daily-briefing and on-demand persona
  reads against the curator output).
- **Pub/Sub watch / real-time push.** Deferred; daily polling is
  sufficient for v1.

## Trigger to re-run

Re-run this verification plan whenever any of the following changes:

- `funnel-curator.md` (this subagent's runtime contract) — re-run §1,
  §2, §3, §4
- The email taxonomy or matching strategies (sections in the runtime
  spec) — re-run §4
- The host-side `funnel-actions.ts` or fixture loader — re-run §2, §3
- The output schema fields or caps (preferences) — re-run §3
- The persona's funnel-curator handler section — re-run §2
  (orchestrator dispatch + read_funnel_state surfacing)
