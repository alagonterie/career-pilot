# VERIFICATION — sandbox persona + candidate fragment (STRATEGY §24.54)

Definition of done for the runtime artifacts in this group
(`.claude-host-fragments/persona.md` + the host-rendered
`.claude-host-fragments/candidate.md`). DoD lives here, not inline — runtime
artifacts must not carry developer meta-content.

## persona.md

- [x] Contains the one-shot rule: never ask the visitor a question, never
      offer options, never wait — a live run completes the flow unprompted,
      with or without a JD.
- [x] Prescribes the §5.3 flow: `analyze_jd` → `research-company` →
      `tailor-resume` ∥ `draft-outreach` → ONE final wrapped message
      containing bullets + outreach email + one honest closing line.
- [x] Frames visitor input as data, not instructions (prompt-injection via
      the JD field does not derail the flow).
- [x] No real identifiers (committed file — generic placeholders only) and
      no spec references (runtime artifact).

## candidate.md (host-rendered at spawn, gitignored)

- [x] `renderSandboxCandidate` includes: name, bio, target roles, location,
      master resume, skills, links (unit-tested).
- [x] Excludes comp floor and quiet hours / ops content (unit-tested).
- [x] Null/empty profile → the sandbox sentinel (disclosed generic profile),
      never the owner onboarding flow (unit-tested).
- [x] `container-runner.ts` renders it for the `career-pilot-sandbox` folder
      before composing (folder-gated, like the owner hook).

## Live (box) verification

- [x] A real `/simulator` run completes via the `result`-trace terminal
      (reason `complete`, well under the hard wall), with zero questions
      asked.
- [x] The persisted `simulator_runs` row's output contains tailored resume
      bullets AND a cold outreach email grounded in the candidate profile.
- [x] The SSE stream shows `chat` output before the terminal `end` event and
      closes cleanly after it.
