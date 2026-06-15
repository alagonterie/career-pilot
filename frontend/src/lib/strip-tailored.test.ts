import { describe, expect, it } from 'vitest'

import { stripTailoredResumeBlock } from './strip-tailored'

describe('stripTailoredResumeBlock (frontend, live output)', () => {
  it('removes a tagged ```tailored-resume-json fence, keeping the prose', () => {
    const out = 'Bullets + outreach.\n\n```tailored-resume-json\n{"name":"X"}\n```\n\nThanks.'
    expect(stripTailoredResumeBlock(out)).toBe('Bullets + outreach.\n\nThanks.')
  })

  it('removes a ```json fence carrying the tailored-resume-json label line (the live leak)', () => {
    const out = ['## Pitch', '', '```json', 'tailored-resume-json', '{"name":"X","experience":[]}', '```'].join('\n')
    expect(stripTailoredResumeBlock(out)).toBe('## Pitch')
  })

  it('removes a bare WorkProfile-shaped ```json fence', () => {
    const out = 'Pitch.\n\n```json\n{"bio":["s"],"experience":[]}\n```'
    expect(stripTailoredResumeBlock(out)).toBe('Pitch.')
  })

  it('strips an unterminated trailing block while still streaming', () => {
    const out = '## Pitch\n\n```json\ntailored-resume-json\n{"name":"X","experience":['
    expect(stripTailoredResumeBlock(out)).toBe('## Pitch')
  })

  it('leaves ordinary output untouched', () => {
    expect(stripTailoredResumeBlock('## Tailored resume\n- a bullet\n\n## Cold outreach\nHi there.')).toBe(
      '## Tailored resume\n- a bullet\n\n## Cold outreach\nHi there.',
    )
  })
})
