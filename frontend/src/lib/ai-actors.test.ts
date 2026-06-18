import { describe, expect, it } from 'vitest'

import { actorPlainText, AI_ACTORS, resolveActor, SYSTEM_ACTOR } from './ai-actors'

describe('ai-actors registry (§24.73)', () => {
  it('describes the six subagents plus the host + system actors, all complete', () => {
    const subagents = AI_ACTORS.filter((a) => a.kind === 'subagent').map((a) => a.name)
    expect(subagents).toEqual([
      'research-company',
      'tailor-resume',
      'draft-outreach',
      'build-interview-kit',
      'scrape-jobs',
      'pipeline-scribe',
    ])
    expect(AI_ACTORS.some((a) => a.kind === 'host' && a.name === 'win-confidence-scorer')).toBe(true)
    // The sanitizer is deterministic (regex), NOT AI — deliberately absent.
    expect(AI_ACTORS.some((a) => a.name === 'sanitizer')).toBe(false)
    expect(SYSTEM_ACTOR.kind).toBe('system')
    // Every actor carries the visitor-facing copy the AgentRef popover renders.
    for (const a of AI_ACTORS) {
      expect(a.role.length).toBeGreaterThan(0)
      expect(a.blurb.length).toBeGreaterThan(20)
      expect(a.access.length).toBeGreaterThan(0)
    }
  })

  it('resolves by exact name, then alias, then substring; null for the unknown', () => {
    expect(resolveActor('tailor-resume')?.name).toBe('tailor-resume')
    // The system actor's name is now 'orchestrator'; its prior name 'my agent
    // system' is kept as a back-compat alias that still resolves to it.
    expect(resolveActor('orchestrator')?.name).toBe('orchestrator')
    expect(resolveActor('my agent system')?.name).toBe('orchestrator')
    // The pre-rename 'funnel-curator' alias is RETIRED (§24.77 / migration 137 made
    // the audit data native) — the legacy name no longer resolves to an actor.
    expect(resolveActor('funnel-curator')).toBeNull()
    // A dispatch label that carries extra decoration still resolves by substring.
    expect(resolveActor('Agent(research-company)')?.name).toBe('research-company')
    expect(resolveActor('totally-unknown-tool')).toBeNull()
    expect(resolveActor('')).toBeNull()
    expect(resolveActor(null)).toBeNull()
  })

  it('renders a natural plain-text reference per kind (for the PDF / alt text)', () => {
    expect(actorPlainText(resolveActor('tailor-resume')!)).toBe('the tailor-resume agent')
    // 'win-confidence' (the raw metric name) resolves to the scorer via alias.
    expect(actorPlainText(resolveActor('win-confidence')!)).toBe('the win-confidence-scorer model')
    expect(actorPlainText(SYSTEM_ACTOR)).toBe('orchestrator')
  })
})
