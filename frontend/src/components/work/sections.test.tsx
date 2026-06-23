import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { WorkProfile } from '~/lib/work-profile'

import { WorkSections } from './sections'

function profile(overrides: Partial<WorkProfile> = {}): WorkProfile {
  return {
    name: 'Test Person',
    title: 'Engineer',
    bio: ['First paragraph.', 'Second paragraph.'],
    lookingFor: ['Senior roles', 'Remote'],
    experience: [
      { role: 'Engineer', company: 'Acme', period: '2020 — Present', bullets: ['Shipped a thing', 'Fixed a bug'] },
    ],
    projects: [{ name: 'career-pilot', description: 'This portal.', href: 'https://example.com', tags: ['Agents'] }],
    skills: ['TypeScript', 'React'],
    education: ['B.S. Computer Science — Example University'],
    links: { github: 'https://github.com/example' },
    ...overrides,
  }
}

describe('WorkSections', () => {
  it('renders the required section headings + content from the profile', () => {
    render(<WorkSections profile={profile()} />)
    for (const heading of ['About', "What I'm looking for", 'Experience', 'Featured project', 'Skills', 'Education']) {
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeInTheDocument()
    }
    expect(screen.getByText('Shipped a thing')).toBeInTheDocument()
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
  })

  it('renders the §24.157 fields — experience descriptor/titles, project bullets/repo, "Featured project" for a lone project', () => {
    render(
      <WorkSections
        profile={profile({
          experience: [
            {
              role: 'Senior Engineer',
              company: 'Acme',
              period: '2020 — Present',
              bullets: ['Did a thing'],
              descriptor: 'A SaaS company (10k+ customers).',
              titles: 'Engineer II (2018–2020)',
            },
          ],
          projects: [
            {
              name: 'career-pilot',
              description: 'This portal.',
              href: 'https://example.com',
              repo: 'https://github.com/example/career-pilot',
              bullets: ['Orchestrates subagents'],
            },
          ],
        })}
      />,
    )
    expect(screen.getByText('A SaaS company (10k+ customers).')).toBeInTheDocument()
    expect(screen.getByText('Engineer II (2018–2020)')).toBeInTheDocument()
    expect(screen.getByText('Orchestrates subagents')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'github.com/example/career-pilot' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Featured project' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Projects' })).not.toBeInTheDocument()
  })

  it('uses the plural "Projects" heading when there are 2+ projects (§24.157)', () => {
    render(
      <WorkSections
        profile={profile({
          projects: [
            { name: 'one', description: 'First.', href: 'https://a.example' },
            { name: 'two', description: 'Second.', href: 'https://b.example' },
          ],
        })}
      />,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Projects' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Featured project' })).not.toBeInTheDocument()
  })

  it('renders **bold** markup as <strong> in bullets, with no literal asterisks (§24.158)', () => {
    render(
      <WorkSections
        profile={profile({
          experience: [
            { role: 'Eng', company: 'Acme', period: '2020 — Present', bullets: ['Cut latency by **90%** overall'] },
          ],
        })}
      />,
    )
    const strong = screen.getByText('90%')
    expect(strong.tagName).toBe('STRONG')
    // The full bullet reassembles with no `**` markers leaking through.
    expect(strong.closest('li')?.textContent).toBe('Cut latency by 90% overall')
  })

  it('drives the scaffold TOC from the present sections (§24.83) — one entry per nav + rail', () => {
    render(<WorkSections profile={profile()} />)
    // The scaffold renders two navs (mobile chips + desktop rail) → one entry per
    // section per nav. No "Elsewhere" entry — that section was removed (D4).
    const entries = screen.getAllByTestId('experience-toc-entry')
    expect(entries.map((e) => e.textContent)).toContain('Experience')
    expect(entries.map((e) => e.textContent)).not.toContain('Elsewhere')
    // Skills present once (skillGroups XOR flat skills), so 6 sections × 2 navs.
    expect(entries).toHaveLength(6 * 2)
    // The mobile ‹ › prev/next steppers are reused here too (§24.83 owner follow-up).
    expect(screen.getByTestId('experience-toc-prev')).toBeInTheDocument()
    expect(screen.getByTestId('experience-toc-next')).toBeInTheDocument()
  })

  it('the removed "Elsewhere" social links no longer render (footer owns socials, §24.83 D4)', () => {
    render(<WorkSections profile={profile({ links: { github: 'https://github.com/example' } })} />)
    expect(screen.queryByRole('heading', { level: 2, name: 'Elsewhere' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument()
  })

  it('renders the optional Writing section only when present (no invented data)', () => {
    const { rerender } = render(<WorkSections profile={profile()} />)
    expect(screen.queryByRole('heading', { level: 2, name: 'Writing & talks' })).not.toBeInTheDocument()

    rerender(<WorkSections profile={profile({ writing: [{ title: 'A post', href: 'https://example.com/p' }] })} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Writing & talks' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'A post' })).toBeInTheDocument()
  })

  it('degrades a partial profile — every section empty → nothing renders (§24.71 / PORTAL §12)', () => {
    // A name-only seed: every list is empty, links absent. No empty headings, no
    // TOC, no thrown render — WorkSections renders null when there is nothing.
    const { container } = render(
      <WorkSections
        profile={profile({
          bio: [],
          lookingFor: [],
          experience: [],
          projects: [],
          skills: [],
          education: [],
          links: {},
        })}
      />,
    )
    for (const heading of ['About', "What I'm looking for", 'Experience', 'Projects', 'Skills', 'Education']) {
      expect(screen.queryByRole('heading', { level: 2, name: heading })).not.toBeInTheDocument()
    }
    expect(container).toBeEmptyDOMElement()
  })
})
