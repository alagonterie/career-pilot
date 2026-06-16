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
    expect(AI_ACTORS.some((a) => a.kind === 'host' && a.name === 'win-confidence')).toBe(true)
    expect(AI_ACTORS.some((a) => a.kind === 'host' && a.name === 'sanitizer')).toBe(true)
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
    // The pre-rename wire/audit name resolves to pipeline-scribe (display alias).
    expect(resolveActor('funnel-curator')?.name).toBe('pipeline-scribe')
    // A dispatch label that carries extra decoration still resolves by substring.
    expect(resolveActor('Agent(research-company)')?.name).toBe('research-company')
    expect(resolveActor('totally-unknown-tool')).toBeNull()
    expect(resolveActor('')).toBeNull()
    expect(resolveActor(null)).toBeNull()
  })

  it('renders a natural plain-text reference per kind (for the PDF / alt text)', () => {
    expect(actorPlainText(resolveActor('tailor-resume')!)).toBe('the tailor-resume agent')
    expect(actorPlainText(resolveActor('win-confidence')!)).toBe('the win-confidence model')
    expect(actorPlainText(SYSTEM_ACTOR)).toBe('my agent system')
  })
})
