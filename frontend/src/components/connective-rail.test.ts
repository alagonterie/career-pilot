import { describe, expect, it } from 'vitest'

import { railConfigFor } from './ConnectiveRail'

describe('railConfigFor (connective rail, PORTAL §8.4)', () => {
  it('gives every deep surface a convert path to /contact', () => {
    for (const p of ['/', '/dashboard', '/architecture', '/pipeline', '/experience', '/about']) {
      const cfg = railConfigFor(p)
      expect(cfg).not.toBeNull()
      const convert = cfg!.items.find((i) => i.kind === 'convert')
      expect(convert && 'to' in convert ? convert.to : null).toBe('/contact')
    }
  })

  it('renders no rail on the sink (/contact) or unmapped routes', () => {
    expect(railConfigFor('/contact')).toBeNull()
    expect(railConfigFor('/watch')).toBeNull() // its own results CTAs are the next step (§24.31)
    expect(railConfigFor('/nope')).toBeNull()
  })

  it('tags ops surfaces ops-register and marketing surfaces marketing', () => {
    expect(railConfigFor('/dashboard')!.register).toBe('ops')
    expect(railConfigFor('/pipeline')!.register).toBe('ops')
    expect(railConfigFor('/architecture')!.register).toBe('ops')
    expect(railConfigFor('/')!.register).toBe('marketing')
    expect(railConfigFor('/experience')!.register).toBe('marketing')
    expect(railConfigFor('/about')!.register).toBe('marketing')
  })

  it('points /about at the repo via an external deepen link (the tell surface → the code)', () => {
    const items = railConfigFor('/about')!.items
    expect(items.some((i) => 'href' in i)).toBe(true)
  })

  it('lets the hub (/dashboard) deepen into architecture', () => {
    const items = railConfigFor('/dashboard')!.items
    expect(items.some((i) => 'to' in i && i.to === '/architecture')).toBe(true)
  })

  it('points architecture at the repo via an external deepen link', () => {
    const items = railConfigFor('/architecture')!.items
    expect(items.some((i) => 'href' in i)).toBe(true)
  })
})
