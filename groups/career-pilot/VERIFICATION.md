# Career Pilot — owner agent verification plan

> **Developer-facing.** Not loaded into the agent's runtime context. The
> sibling `.claude-host-fragments/persona.md` is the persona spec
> (composed into the agent's runtime system prompt via our composer
> extension — see `src/claude-md-compose.ts` and NANOCLAW_INTERNALS.md
> §4). This file is the verification target for that spec — how we check
> that the agent's behavior matches what `persona.md` describes.
>
> The group's `CLAUDE.md` file is composer-generated (regenerated every
> container spawn) — do NOT treat it as authored content.
>
> Move this file in lockstep with the persona: when `persona.md` changes
> meaningfully, this verification plan updates too.

## Definition of done

The persona at `.claude-host-fragments/persona.md` is the behavioral
contract for the owner agent. "Done" means the agent's actual behavior
matches what's described there. The verification plan, in increasing
rigor:

### 1. Voice red-team (manual, ~30 min)

Paste 10 conversational scenarios into a test harness covering the
spectrum:

- Routine status update ("how's my pipeline today?")
- Ambiguous request ("look into Acme for me")
- Agent mistake recovery (after a wrong-recipient draft)
- Candidate venting after rejection
- Mid-process disagreement (agent spots a fit problem)
- Irreversible action approval flow (`send_outreach_email`)
- Quiet-hours edge case (low-priority event at 23:00)
- Onboarding flow (empty / missing `.claude-host-fragments/candidate.md`)
- Coaching moment (3rd rejection at the same interview stage)
- Hard refusal (candidate asks for fabricated metrics)

The agent's responses should match:
- **Output protocol (load-bearing, check first):** every reply wrapped in
  `<message to="name">...</message>` blocks. Unwrapped text is scratchpad
  and never reaches the candidate — a response that's voice-perfect but
  unwrapped is a hard fail. See NANOCLAW_INTERNALS.md §6 for the
  protocol. `<internal>...</internal>` scratchpad is allowed and
  expected for reflection prompting.
- **Voice rules:** no sycophancy ("Great question!"), no apology theater
  ("I'm so sorry — major oversight"), brief, peer register
- **Autonomy gradient:** right action class for each scenario (just-do /
  notify-after / confirm-before / refuse)

Failures get filed as either spec gaps (persona needs refinement) or
implementation bugs (code/wiring drift between persona and runtime
behavior).

### 2. Autonomy gradient compliance (manual + log review)

For each of the four action classes, exercise at least one tool/action.
Check the `pipeline_events` log + Telegram thread:

- **Just-do** actions land silently (no Telegram notification)
- **Notify-after** actions emit a single one-liner — wrapped in
  `<message to="owner">...</message>`
- **Confirm-before** actions present an approval card (via the host-side
  approvals module — NOT inline text) and wait for explicit yes
- **Refuse** actions return a brief refusal, no moralizing — wrapped

Wrapping compliance is verified on every outbound row: read recent
`messages_out` from the session's `outbound.db` via `scripts/q.ts` and
confirm each `content` field deserializes to a single `text` block (i.e.
the agent's `<message to="owner">...</message>` was parsed and dispatched
cleanly). Repeated unwrapped-text warnings in the poll-loop logs (search
for `WARNING: agent output had no <message to="..."> blocks`) indicate
the persona's output protocol guidance isn't sticking and needs
strengthening.

### 3. Proactivity calibration (1-2 weeks shadow run, Phase 9)

During shadow mode (`LIVE_MODE=false`), observe whether the agent's
unprompted messages pass the "would the candidate be glad I interrupted?"
bar.

Track:
- Briefings per day (target: 0-2, agent-decided based on material news)
- Frequency cap hits (`preferences.telegram_proactive_frequency_cap_per_day`)
- Quiet-hours violations (should be zero unless critical category)

Adjust the persona if the pattern is consistently off in either direction
(too noisy, too quiet).

### 4. Sanitization-awareness check (automated, Phase 3+)

When the agent produces output bound for `record_pipeline_event` payloads,
the sanitization pipeline should rarely have non-trivial work to do. If
Pass 2 (company alias replacement) or Pass 3 (Haiku review) is
consistently rewriting agent output, the persona isn't internalizing the
"write as if there's no sanitization" rule and needs adjustment.

Concrete signal: track `public_audit_trail.summary` length-delta vs the
private `pipeline_events.payload` summary. Large deltas = the sanitizer is
doing structural work the agent should have already done.

### 5. Reflection loop quality (qualitative, Phase 4+)

After 5 rejections in production, read the resulting `learnings` rows.
They should have substantive `what_didnt` / `next_time` content, not
boilerplate. If reflections are shallow, the prompting templates in the
persona's "Reflection prompting" section need work.

## Out of scope for this verification plan

- **Tool implementation correctness.** That's per-tool — see (eventual)
  per-tool DoD in `container/agent-runner/src/mcp-tools/`.
- **Subagent prompt quality.** Each subagent has its own definition file
  and its own implicit DoD; treat separately.
- **Sanitization correctness.** Verification of the sanitization pipeline
  itself lives in `.specs/STRATEGY.md` §9 + tests in
  `src/modules/portal/sanitizer.test.ts` (Phase 3+).

## Trigger to re-run

Re-run the relevant subset of this plan whenever any of the following
changes:

- `.claude-host-fragments/persona.md` (the persona spec) — re-run §1, §2 at minimum
- Voice rules section specifically — §1
- Output format section — §1, §2 (wrapping compliance)
- Autonomy gradient catalogs — §2
- Proactivity rules — §3 (during the next shadow window)
- Reflection prompting templates — §5
- The composer extension in `src/claude-md-compose.ts` — re-run §1 to confirm host-fragments are being included in the composed CLAUDE.md as expected
