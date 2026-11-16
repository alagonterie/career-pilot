# draft-outreach — Definition of Done

Developer-facing DoD for the SHARED `draft-outreach` subagent
(`groups/_shared-subagents/draft-outreach.md`, composed into both the owner
group and the public simulator). Not rendered into any runtime prompt — the
composer skips `*.VERIFICATION.md` (`isRenderableSubagentSource`). Governing
spec: STRATEGY.md §24.203 D5.

## Frontmatter

- [ ] `name: draft-outreach`; `tools:` is exactly `[mcp__nanoclaw__record_progress]`
      — no Gmail, fetch, search or Agent tools.
- [ ] No spec references (`§`, `STRATEGY`, `.specs`) anywhere in the runtime file.

## Recipient modes

- [ ] **Normal mode:** a `## Recipient` block with `recipient_email` → the draft is
      written to that person; the address is used verbatim.
- [ ] **No-recipient mode triggers ONLY on the explicit `## Recipient: none` line.**
      With it, the subagent returns `## Subject` + `## Body` (+ justification),
      addressed to the role the brief describes, else the hiring team — never a
      made-up name or address.
- [ ] **Mere absence is still a refusal:** a brief with neither a recipient email
      nor `## Recipient: none` returns the single `## Cannot proceed — no recipient
      provided…` line.
- [ ] In either mode the subagent makes **no draft-tool call** (it has none; the
      only tool call in its run is `record_progress`).

## Output + honesty (unchanged)

- [ ] Subject ≤ 60 chars, body ≤ 200 words, `[adapted]`/`[new]` tags, no signature,
      no fabricated metrics/employers/technologies, `[inferred]` framed honestly.

## Callers that emit the no-recipient block (both must, identically)

- [ ] Owner persona's admin-action handler (`groups/career-pilot/.claude-host-fragments/persona.md`):
      emits `## Recipient: none` when `get_admin_action` returned no
      `recipient_from_note`; does NOT call `create_gmail_draft`; writes the result
      with `complete_admin_action`.
- [ ] Sandbox persona (`groups/career-pilot-sandbox/.claude-host-fragments/persona.md`)
      step 3: emits `## Recipient: none` + `role: hiring manager for this role`.

## Live verification (owner-approved; agent spend on dev is off)

- [ ] One simulator run on the box: the cold-email card renders a subject + body
      addressed generically; the run's tool trace shows no draft-tool call.
- [ ] One owner *Draft outreach* press with no address in the note: the action
      lands `done` with subject + body and `to: null`; the ops turn's tool trace
      has no `create_gmail_draft`.
- [ ] One press whose note names an address: `result_json.to` is that address.
