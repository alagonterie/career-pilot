import { describe, expect, it } from 'vitest'

import { FOOTER_CREDITS, footerSocials } from './SiteFooter'
import type { Identity } from '~/lib/profile-loader'

const full: Identity = {
  email: 'jane@example.com',
  github: 'https://github.com/janedoe',
  linkedin: 'https://www.linkedin.com/in/janedoe',
  x: 'https://x.com/janedoe',
  website: 'https://janedoe.example.com',
}

describe('footerSocials', () => {
  it('builds one link per non-null social, in order, carrying the href', () => {
    expect(footerSocials(full).map((s) => s.label)).toEqual(['GitHub', 'LinkedIn', 'X', 'Website'])
    expect(footerSocials(full).map((s) => s.href)).toEqual([
      'https://github.com/janedoe',
      'https://www.linkedin.com/in/janedoe',
      'https://x.com/janedoe',
      'https://janedoe.example.com',
    ])
  })

  it('omits each social whose field is null (never faked) — a fork with no X shows no X link', () => {
    expect(footerSocials({ ...full, x: null }).map((s) => s.label)).toEqual(['GitHub', 'LinkedIn', 'Website'])
  })

  it('is empty when no socials are set, and never surfaces email', () => {
    expect(footerSocials({ email: 'jane@example.com', github: null, linkedin: null, x: null, website: null })).toEqual(
      [],
    )
  })
})

describe('FOOTER_CREDITS', () => {
  it('credits the headline stack in order, each with an absolute https href', () => {
    expect(FOOTER_CREDITS.map((c) => c.label)).toEqual(['NanoClaw', 'Claude', 'TanStack Start'])
    expect(FOOTER_CREDITS.map((c) => c.href)).toEqual([
      'https://github.com/nanocoai/nanoclaw',
      'https://claude.com',
      'https://tanstack.com/start',
    ])
    for (const c of FOOTER_CREDITS) expect(c.href).toMatch(/^https:\/\//)
  })
})
