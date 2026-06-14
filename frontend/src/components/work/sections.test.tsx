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
    for (const heading of [
      'About',
      "What I'm looking for",
      'Experience',
      'Projects',
      'Skills',
      'Education',
      'Elsewhere',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeInTheDocument()
    }
    expect(screen.getByText('Shipped a thing')).toBeInTheDocument()
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/example')
  })

  it('renders the optional Writing section only when present (no invented data)', () => {
    const { rerender } = render(<WorkSections profile={profile()} />)
    expect(screen.queryByRole('heading', { level: 2, name: 'Writing & talks' })).not.toBeInTheDocument()

    rerender(<WorkSections profile={profile({ writing: [{ title: 'A post', href: 'https://example.com/p' }] })} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Writing & talks' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'A post' })).toBeInTheDocument()
  })

  it('omits optional link entries that are absent', () => {
    render(<WorkSections profile={profile({ links: { github: 'https://github.com/example' } })} />)
    expect(screen.getByRole('link', { name: 'GitHub' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'LinkedIn' })).not.toBeInTheDocument()
  })

  it('degrades a partial profile — empty sections omit their heading (§24.71 / PORTAL §12)', () => {
    // A name-only seed: every list is empty, links absent. No empty headings,
    // and no thrown render.
    render(
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
    for (const heading of [
      'About',
      "What I'm looking for",
      'Experience',
      'Projects',
      'Skills',
      'Education',
      'Elsewhere',
    ]) {
      expect(screen.queryByRole('heading', { level: 2, name: heading })).not.toBeInTheDocument()
    }
  })
})
