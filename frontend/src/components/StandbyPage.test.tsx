import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { StandbySnapshot, StandbyState } from '~/lib/standby'

import { StandbyPage, standbyLinks } from './StandbyPage'

const STATE: StandbyState = {
  mode: 'standby',
  since: '2026-07-08T00:00:00.000Z',
  note: null,
  vm: 'stopped',
  updatedAt: '2026-07-08T00:00:05.000Z',
}

const SNAPSHOT: StandbySnapshot = {
  name: 'A Candidate',
  email: 'a@example.com',
  github: 'https://github.com/example',
  linkedin: 'https://linkedin.com/in/example',
  x: null,
  website: null,
  capturedAt: '2026-07-08T00:00:00.000Z',
}

const NOW = Date.parse('2026-08-07T00:00:00.000Z')

describe('StandbyPage (§24.189)', () => {
  it('states plainly that the search is paused — not that something is broken', () => {
    render(<StandbyPage state={STATE} snapshot={SNAPSHOT} now={NOW} />)
    expect(screen.getByTestId('standby-statement')).toHaveTextContent(/not actively looking/i)
    // The `/halt` outage language must never leak onto this page.
    expect(screen.getByTestId('standby-page')).not.toHaveTextContent(/offline|back shortly|error/i)
  })

  it('renders the captured identity so the page never falls back to the placeholder', () => {
    render(<StandbyPage state={STATE} snapshot={SNAPSHOT} now={NOW} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A Candidate')
    expect(screen.getByTestId('standby-email')).toHaveAttribute('href', 'mailto:a@example.com')
  })

  it('still renders with NO snapshot (name from the build-time constant, links omitted)', () => {
    render(<StandbyPage state={STATE} snapshot={null} now={NOW} />)
    expect(screen.getByTestId('standby-page')).toBeInTheDocument()
    expect(screen.queryByTestId('standby-email')).not.toBeInTheDocument()
    expect(screen.queryByTestId('standby-links')).not.toBeInTheDocument()
  })

  it('shows the owner note only when one is set', () => {
    render(<StandbyPage state={STATE} snapshot={SNAPSHOT} now={NOW} />)
    expect(screen.queryByTestId('standby-note')).not.toBeInTheDocument()
  })

  it('renders a set owner note verbatim', () => {
    render(<StandbyPage state={{ ...STATE, note: 'Started somewhere great.' }} snapshot={SNAPSHOT} now={NOW} />)
    expect(screen.getByTestId('standby-note')).toHaveTextContent('Started somewhere great.')
  })

  it('says the infrastructure is stopped, not deleted', () => {
    render(<StandbyPage state={STATE} snapshot={SNAPSHOT} now={NOW} />)
    expect(screen.getByTestId('standby-since')).toHaveTextContent('30 days')
    expect(screen.getByTestId('standby-since')).toHaveTextContent(/stopped, not deleted/i)
  })
})

describe('standbyLinks (§24.189 — omit-when-null)', () => {
  it('emits one link per non-null field, in order', () => {
    expect(standbyLinks(SNAPSHOT).map((l) => l.label)).toEqual(['GitHub', 'LinkedIn'])
  })

  it('is empty with no snapshot or an empty one', () => {
    expect(standbyLinks(null)).toEqual([])
    expect(
      standbyLinks({ name: null, email: null, github: null, linkedin: null, x: null, website: null, capturedAt: null }),
    ).toEqual([])
  })
})
