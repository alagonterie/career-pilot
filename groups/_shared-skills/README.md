# Shared skill source

Skill instructions and subagent prompt bodies that apply to BOTH agent groups
(`career-pilot/` and `career-pilot-sandbox/`) live here. `scripts/sync-shared-skills.ts`
copies them into both groups' folders at build time.

## Why shared

The skill *prompts* are identical across groups — the difference is which MCP
tools the container exposes (controlled by `container_configs.allowedTools` /
`disallowedTools`, see STRATEGY.md §4). Same instructions, different tool palette.

## Structure

```
_shared-skills/
├── research-company/
│   └── SKILL.md
├── tailor-resume/
│   └── SKILL.md
├── draft-outreach/
│   └── SKILL.md
├── prep-interview/         (owner only — sandbox doesn't get this)
│   └── SKILL.md
└── scrape-jobs/            (owner only — sandbox doesn't get this)
    └── SKILL.md
```

## Phase 0 status

PLACEHOLDER. Skill SKILL.md bodies will be written in Phase 2 alongside the
subagent prompt bodies. The sync script will then duplicate them into the
group folders.
