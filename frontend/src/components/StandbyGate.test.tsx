import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ACTIVE_STATE, type StandbyState } from '~/lib/standby'

import { StandbyGate } from './StandbyGate'

// The gate reads the current path from the router; stub it rather than mounting a
// full router just to assert the branch.
let pathname = '/'
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname } }),
}))

const STANDBY: StandbyState = {
  mode: 'standby',
  since: '2026-08-01T00:00:00.000Z',
  note: null,
  vm: 'stopped',
  updatedAt: null,
}

function renderAt(path: string, state: StandbyState) {
  pathname = path
  return render(
    <StandbyGate state={state} snapshot={null}>
      <div data-testid="live-site">the live site</div>
    </StandbyGate>,
  )
}

describe('StandbyGate (§24.189 D6)', () => {
  it('renders the normal site when not on standby', () => {
    renderAt('/', ACTIVE_STATE)
    expect(screen.getByTestId('live-site')).toBeInTheDocument()
    expect(screen.queryByTestId('standby-page')).not.toBeInTheDocument()
  })

  it('replaces every backend-fed surface with the standby page', () => {
    for (const path of ['/', '/work', '/contact', '/pipeline', '/live', '/admin']) {
      const { unmount } = renderAt(path, STANDBY)
      expect(screen.getByTestId('standby-page')).toBeInTheDocument()
      expect(screen.queryByTestId('live-site')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('exempts the edge console — it has to work precisely when the origin does not', () => {
    renderAt('/admin/standby', STANDBY)
    expect(screen.getByTestId('live-site')).toBeInTheDocument()
    expect(screen.queryByTestId('standby-page')).not.toBeInTheDocument()
  })

  it('exempts the static legal pages', () => {
    for (const path of ['/privacy', '/terms']) {
      const { unmount } = renderAt(path, STANDBY)
      expect(screen.getByTestId('live-site')).toBeInTheDocument()
      unmount()
    }
  })
})
