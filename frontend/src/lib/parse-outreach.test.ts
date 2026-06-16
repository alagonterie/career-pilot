import { describe, expect, it } from 'vitest'

import { parseOutreach } from './parse-outreach'

describe('parseOutreach', () => {
  it('parses the real-run shape (## Cold Outreach Email + **Subject:** + closing note)', () => {
    const text = [
      '## Tailored Resume Bullets',
      '',
      '- a bullet',
      '',
      '---',
      '',
      '## Cold Outreach Email',
      '',
      '**Subject:** Staff Performance Engineer — Photon query optimization',
      '',
      'Hi there,',
      '',
      'Your Photon engine caught my attention.',
      '',
      '---',
      '',
      '**Closing note:** Role requirements inferred from the title.',
    ].join('\n')
    const out = parseOutreach(text)
    expect(out?.subject).toBe('Staff Performance Engineer — Photon query optimization')
    expect(out?.body).toContain('Hi there,')
    expect(out?.body).toContain('Your Photon engine caught my attention.')
    expect(out?.body).not.toContain('Closing note') // the note is excluded
  })

  it('parses the mock/seed shape (## Cold outreach — Co + Subject: no bold)', () => {
    const text = [
      '## Tailored resume — Principal Engineer @ Wayne Enterprises',
      '',
      '- a bullet',
      '',
      '## Cold outreach — Wayne Enterprises',
      '',
      'Subject: Principal Engineer — a builder who ships at your scale',
      '',
      'Hi there, I came across your recent engineering work.',
    ].join('\n')
    const out = parseOutreach(text)
    expect(out?.subject).toBe('Principal Engineer — a builder who ships at your scale')
    expect(out?.body).toBe('Hi there, I came across your recent engineering work.')
  })

  it('returns null when there is no outreach section', () => {
    expect(parseOutreach('## Tailored resume\n\n- only bullets here')).toBeNull()
    expect(parseOutreach('')).toBeNull()
  })
})
