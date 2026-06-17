import { describe, expect, it } from 'vitest'

import { looksLikeGarbage } from './SimInput'

describe('looksLikeGarbage (STRATEGY §24.104)', () => {
  it('flags a single character repeated', () => {
    for (const v of ['aaaa', 'xxxx', '....', '----', 'a a a a']) {
      expect(looksLikeGarbage(v)).toBe(true)
    }
  })

  it('flags strings with no letters at all', () => {
    for (const v of ['1234', '!!!', '   ', '99', '#$%']) {
      expect(looksLikeGarbage(v)).toBe(true)
    }
  })

  it('passes real (even short or obscure) names', () => {
    for (const v of ['IBM', 'Box', 'X Corp', 'Stripe', '37signals', 'a16z', 'H-E-B', 'Äland AB']) {
      expect(looksLikeGarbage(v)).toBe(false)
    }
  })

  it('ignores surrounding whitespace when judging', () => {
    expect(looksLikeGarbage('  Acme  ')).toBe(false)
    expect(looksLikeGarbage('  aaaa  ')).toBe(true)
  })
})
