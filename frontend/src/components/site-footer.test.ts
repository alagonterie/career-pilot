import { afterEach, describe, expect, it, vi } from 'vitest'

import { FOOTER_CREDITS, footerSocials } from './SiteFooter'
import type { Identity } from '~/lib/profile-loader'
import { appVersion } from '~/lib/site'

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

describe('appVersion (the footer version chip — §24.139)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is a deterministic, link-free `dev` when unset (no SHA in a @visual baseline)', () => {
    expect(appVersion()).toEqual({ label: 'dev', href: null })
  })

  it('links a prod tag to its GitHub release, composing the href from REPO_URL', () => {
    vi.stubEnv('VITE_APP_VERSION', 'v1.0.0')
    vi.stubEnv('VITE_APP_VERSION_REF', 'releases/tag/v1.0.0')
    const v = appVersion()
    expect(v.label).toBe('v1.0.0')
    expect(v.href).toMatch(/^https:\/\/.+\/releases\/tag\/v1\.0\.0$/)
  })

  it('links a dev build to its commit', () => {
    vi.stubEnv('VITE_APP_VERSION', 'dev · 0b2e450')
    vi.stubEnv('VITE_APP_VERSION_REF', 'commit/0b2e450abc')
    const v = appVersion()
    expect(v.label).toBe('dev · 0b2e450')
    expect(v.href).toMatch(/\/commit\/0b2e450abc$/)
  })
})
