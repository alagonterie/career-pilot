import { describe, expect, it } from 'vitest'

import { railConfigFor } from './ConnectiveRail'

describe('railConfigFor (connective rail, PORTAL §8.4)', () => {
  it('gives every deep surface a convert path to /contact', () => {
    for (const p of ['/', '/live', '/architecture', '/pipeline', '/work', '/about']) {
      const cfg = railConfigFor(p)
      expect(cfg).not.toBeNull()
      const convert = cfg!.items.find((i) => i.kind === 'convert')
      expect(convert && 'to' in convert ? convert.to : null).toBe('/contact')
    }
  })

  it('renders no rail on the sink (/contact) or unmapped routes', () => {
    expect(railConfigFor('/contact')).toBeNull()
    expect(railConfigFor('/simulator')).toBeNull() // not built yet — lands in 8.2
    expect(railConfigFor('/nope')).toBeNull()
  })

  it('tags ops surfaces ops-register and marketing surfaces marketing', () => {
    expect(railConfigFor('/live')!.register).toBe('ops')
    expect(railConfigFor('/pipeline')!.register).toBe('ops')
    expect(railConfigFor('/architecture')!.register).toBe('ops')
    expect(railConfigFor('/')!.register).toBe('marketing')
    expect(railConfigFor('/work')!.register).toBe('marketing')
    expect(railConfigFor('/about')!.register).toBe('marketing')
  })

  it('points /about at the repo via an external deepen link (the tell surface → the code)', () => {
    const items = railConfigFor('/about')!.items
    expect(items.some((i) => 'href' in i)).toBe(true)
  })

  it('lets the hub (/live) deepen into architecture', () => {
    const items = railConfigFor('/live')!.items
    expect(items.some((i) => 'to' in i && i.to === '/architecture')).toBe(true)
  })

  it('points architecture at the repo via an external deepen link', () => {
    const items = railConfigFor('/architecture')!.items
    expect(items.some((i) => 'href' in i)).toBe(true)
  })
})
