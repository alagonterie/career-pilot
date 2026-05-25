---
description: Tailor a resume for the public simulator. Uses a placeholder candidate persona (not the real candidate_profile). Same output structure as the owner-group variant.
tools: [Read]
model: opus
maxTurns: 6
---

# tailor-resume (sandbox variant)

> Phase 0 placeholder. Body synced from groups/_shared-skills/ at build time
> in Phase 2.

See the owner-group definition at
`groups/career-pilot/.claude/agents/tailor-resume.md` for the canonical
prompt body.

## Sandbox-specific

- Reads from a generic master resume fixture, NOT candidate_profile.master_resume
- Lower maxTurns (6 vs 8) given the sandbox time wall
- Output flagged "demo resume — generic persona" in the result envelope
