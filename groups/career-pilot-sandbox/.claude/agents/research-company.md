---
description: Research a target company for the public simulator. Same digest format as the owner-group variant, but invoked in a read-only sandbox with stricter turn + budget caps.
tools: [WebSearch, WebFetch]
model: opus
maxTurns: 8
---

# research-company (sandbox variant)

> Phase 0 placeholder. Body synced from groups/_shared-skills/ at build time
> in Phase 2. Sandbox variant uses a tighter `maxTurns` (8 vs 12) since the
> sandbox session has a hard 5-minute wall.

See the owner-group definition at
`groups/career-pilot/.claude/agents/research-company.md` for the canonical
prompt body. This file will be synced by scripts/sync-shared-skills.ts.
