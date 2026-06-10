import { describe, expect, it } from 'vitest'

import { humanizeTraceSummary } from './trace-summary'
import type { SimTraceEvent } from './use-simulator-run'

function ev(partial: Partial<SimTraceEvent>): SimTraceEvent {
  return { t: 'tool', ...partial }
}

describe('humanizeTraceSummary', () => {
  it('returns null for an absent summary', () => {
    expect(humanizeTraceSummary(ev({ name: 'WebSearch' }))).toBeNull()
    expect(humanizeTraceSummary(ev({ name: 'WebSearch', input_summary: '  ' }))).toBeNull()
  })

  it('extracts the query for WebSearch (quoted)', () => {
    const out = humanizeTraceSummary(
      ev({ name: 'WebSearch', input_summary: '{"query":"Stripe engineering blog 2026"}' }),
    )
    expect(out).toBe('“Stripe engineering blog 2026”')
  })

  it('strips exact-match quotes inside a query so the curly wrap does not nest', () => {
    const out = humanizeTraceSummary(
      ev({ name: 'WebSearch', input_summary: '{"query":"\\"Acme Corp\\" engineering culture 2026"}' }),
    )
    expect(out).toBe('“Acme Corp engineering culture 2026”')
  })

  it('shortens the url for WebFetch', () => {
    const out = humanizeTraceSummary(
      ev({
        name: 'WebFetch',
        input_summary: '{"url":"https://careers.datadoghq.com/engineering/","prompt":"What does…"}',
      }),
    )
    expect(out).toBe('careers.datadoghq.com/engineering')
  })

  it('prefers the description for subagent dispatches', () => {
    const out = humanizeTraceSummary(
      ev({
        t: 'subagent',
        subagent: 'research-company',
        input_summary: '{"description":"Research Stripe company background","subagent_type":"research-company"}',
      }),
    )
    expect(out).toBe('Research Stripe company background')
  })

  it('survives a truncated JSON summary (the wire caps it)', () => {
    const truncated =
      '{"subagent_type":"research-company","description":"Research Globex company background","prompt":"Research Globex company: recent news, engineering culture, team composition, tech stack, public enginee…'
    const out = humanizeTraceSummary(ev({ name: 'Agent', input_summary: truncated }))
    expect(out).toBe('Research Globex company background')
  })

  it('caps very long output with an ellipsis', () => {
    const out = humanizeTraceSummary(ev({ name: 'WebSearch', input_summary: `{"query":"${'x'.repeat(300)}"}` }))
    expect(out!.length).toBeLessThanOrEqual(112)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('falls back to a de-JSONed raw string when nothing matches', () => {
    const out = humanizeTraceSummary(ev({ name: 'MysteryTool', input_summary: '{"weird":"shape"}' }))
    expect(out).toBeTruthy()
    expect(out!.startsWith('{')).toBe(false)
  })
})
