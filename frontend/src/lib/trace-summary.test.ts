import { describe, expect, it } from 'vitest'

import { dispatchLabel, humanizeTraceSummary } from './trace-summary'
import type { SimTraceEvent } from './use-simulator-run'

function ev(partial: Partial<SimTraceEvent>): SimTraceEvent {
  return { t: 'tool', ...partial }
}

describe('dispatchLabel — §24.161 branded tools, no framework-name leak', () => {
  it('strips the mcp__<server>__ prefix so the framework name never shows on the public trace', () => {
    expect(dispatchLabel(ev({ name: 'mcp__nanoclaw__some_internal_tool' }))).toBe('some_internal_tool')
  })
  it('relabels the two emit tools as branded milestones', () => {
    expect(dispatchLabel(ev({ name: 'mcp__nanoclaw__emit_tailored_resume' }))).toBe('Produced the tailored résumé')
    expect(dispatchLabel(ev({ name: 'mcp__nanoclaw__emit_cold_email' }))).toBe('Drafted the outreach email')
  })
  it('leaves a plain (non-mcp) tool name untouched', () => {
    expect(dispatchLabel(ev({ name: 'WebSearch' }))).toBe('WebSearch')
  })
})

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
      ev({ name: 'WebSearch', input_summary: '{"query":"\\"Acme\\" engineering culture 2026"}' }),
    )
    expect(out).toBe('“Acme engineering culture 2026”')
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

  it('suppresses the JSON payload for emit_tailored_resume — the label stands alone (§24.161)', () => {
    expect(
      humanizeTraceSummary(
        ev({ name: 'mcp__nanoclaw__emit_tailored_resume', input_summary: '{"profile":{"bio":["x"]}}' }),
      ),
    ).toBeNull()
  })

  it('shows the subject (not the raw JSON) for emit_cold_email (§24.161)', () => {
    const out = humanizeTraceSummary(
      ev({ name: 'mcp__nanoclaw__emit_cold_email', input_summary: '{"subject":"Backend role at Acme","body":"Hi…"}' }),
    )
    expect(out).toBe('“Backend role at Acme”')
  })
})
