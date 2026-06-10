# build-interview-kit — Definition of Done

Developer-facing DoD for the `build-interview-kit` subagent (this file is NOT
rendered into the runtime system prompt — `isRenderableSubagentSource` skips
`*.VERIFICATION.md`). Verifies the subagent behaves per the mock-interview-kit
design.

## Frontmatter

- [ ] `name: build-interview-kit` present (load-bearing — the SDK discovers the
      subagent by this field).
- [ ] `tools:` is exactly `[mcp__nanoclaw__persist_interview_kit,
      mcp__nanoclaw__record_progress]` — no fetch/search/Agent tools.
- [ ] `model: opus`, `maxTurns: 12`.

## Inputs + refusal

- [ ] Reads candidate profile from the auto-loaded `candidate.md`, the research
      digest + `## Interview` block from the invocation prompt.
- [ ] Refuses (single `## Cannot proceed …` line, NO writer call) when
      `application_id`, `round`, or `interview_type` is missing.
- [ ] Missing/thin research → best-effort kit + an honest caveat, NOT a refusal.

## Output

- [ ] Produces a two-part markdown kit: **Part 1** interviewer operating-manual
      (Your role + Scoring rubric + Question themes + Grounding/caveats + Gap
      notes) and **Part 2** candidate quick-reference (Recent signal + Lean into
      + Questions to ask).
- [ ] Uses the REAL company name (private Drive — no sanitization).
- [ ] No fabricated experience; no first-person "Example:" stories (placeholder
      shapes only); no STAR/confidence platitudes; `[inferred]` framed honestly.
- [ ] Within the ~900-word soft / ~1200 hard cap.

## Progress attribution

- [ ] Every `record_progress` call passes `application_id` (from the
      `## Interview` block) so the public stream attributes the work to the
      application — the host derives the public-safe label; the detail text
      stays company-generic regardless.

## Writer

- [ ] Calls `persist_interview_kit` EXACTLY ONCE, at the end, with
      `{ application_id, round, interview_type, title, markdown, interview_at? }`.
- [ ] `title` shaped `Interview Kit — <Company> — <Round> — <YYYY-MM-DD>`.
- [ ] On writer error: surfaces briefly, stops — no retry loop, no fake success.
- [ ] Ends with a one-line confirmation + the returned `drive_url`; does NOT
      paste the whole kit back.

## Runtime wiring (covered by host tests, not the subagent itself)

- [ ] `persist_interview_kit` is registered container-side
      (`mcp-tools/interview-kit.ts`) and host-side
      (`career_pilot.persist_interview_kit`, owner-only).
- [ ] The host enqueues `[scheduled trigger: build-interview-kit]` on entry to an
      interview stage; the orchestrator's handler dispatches research (if stale)
      then this subagent (persona).
