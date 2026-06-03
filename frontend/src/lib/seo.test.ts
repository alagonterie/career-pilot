import { describe, expect, it } from 'vitest'

import { seo } from './seo'

type Meta = ReturnType<typeof seo>['meta']

function content(meta: Meta, key: 'name' | 'property', val: string): string | undefined {
  for (const m of meta) {
    if (key in m && (m as Record<string, string>)[key] === val && 'content' in m) return m.content
  }
  return undefined
}

describe('seo (§24.36 36.5)', () => {
  it('builds the full title + OG + Twitter-card set, with absolute og:url/og:image', () => {
    const { meta } = seo({ title: 'Live — Jane Doe', description: 'D', path: '/live' })
    expect(meta.find((m) => 'title' in m)).toEqual({ title: 'Live — Jane Doe' })
    expect(content(meta, 'name', 'description')).toBe('D')
    expect(content(meta, 'property', 'og:title')).toBe('Live — Jane Doe')
    expect(content(meta, 'property', 'og:description')).toBe('D')
    expect(content(meta, 'property', 'og:type')).toBe('website')
    expect(content(meta, 'property', 'og:site_name')).toBe('Career Pilot')
    // Scrapers reject relative URLs — these must be absolute.
    expect(content(meta, 'property', 'og:url')).toBe('https://hire.example.com/live')
    expect(content(meta, 'property', 'og:image')).toBe('https://hire.example.com/og.png')
    // The big-image card layout on X.
    expect(content(meta, 'name', 'twitter:card')).toBe('summary_large_image')
    expect(content(meta, 'name', 'twitter:image')).toBe('https://hire.example.com/og.png')
  })

  it('defaults the description + image, and the path to the site origin', () => {
    const { meta } = seo({ title: 'Jane Doe — an AI agent runs my job search, live' })
    expect(content(meta, 'property', 'og:url')).toBe('https://hire.example.com/')
    expect(content(meta, 'property', 'og:image')).toBe('https://hire.example.com/og.png')
    expect(content(meta, 'name', 'description')).toMatch(/AI agent/i)
  })

  it('passes an already-absolute image through unchanged', () => {
    const { meta } = seo({ title: 'T', image: 'https://cdn.example.com/x.png' })
    expect(content(meta, 'property', 'og:image')).toBe('https://cdn.example.com/x.png')
  })
})
