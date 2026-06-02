import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'

import { ArchDiagram } from './ArchDiagram'
import { Legend, ModeBanner } from './ModeBanner'
import { NodePanel } from './NodePanel'
import { deriveNodeStatus, NODES, type ArchNode, type ProbeKind } from './nodes'

const ARCH: ArchitectureData = {
  sessions: { active: 2, running: 2 },
  containers: { running: 2, capacity_max: 4, memory_mb_each: 512, runtime: 'up' },
  backend: 'online',
}
const MODE: SystemMode = { live_mode: true, pause_state: 'active', pause_reason: null, backend: 'online' }

function node(probe: ProbeKind): ArchNode {
  return { id: 't', label: 't', region: 'host', probe, description: '', x: 0, y: 0, w: 0, h: 0 }
}
function byId(id: string): ArchNode {
  const n = NODES.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('deriveNodeStatus (the honesty core)', () => {
  it('never paints a structural node', () => {
    expect(deriveNodeStatus(node('structural'), ARCH, MODE)).toBe('structural')
  })

  it('maps host pause-state to the traffic light', () => {
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'active' })).toBe('healthy')
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'paused' })).toBe('degraded')
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'halted' })).toBe('down')
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'killswitch' })).toBe('down')
    expect(deriveNodeStatus(node('pause'), ARCH, null)).toBe('idle')
  })

  it('reads backend / container / sessions honestly', () => {
    expect(deriveNodeStatus(node('backend'), ARCH, MODE)).toBe('healthy')
    expect(deriveNodeStatus(node('backend'), null, MODE)).toBe('idle')
    expect(
      deriveNodeStatus(node('container'), { ...ARCH, containers: { ...ARCH.containers, runtime: 'down' } }, MODE),
    ).toBe('down')
    expect(deriveNodeStatus(node('container'), { ...ARCH, containers: { ...ARCH.containers, running: 0 } }, MODE)).toBe(
      'idle',
    )
    expect(deriveNodeStatus(node('sessions'), { ...ARCH, sessions: { active: 0, running: 0 } }, MODE)).toBe('idle')
    expect(deriveNodeStatus(node('sessions'), ARCH, MODE)).toBe('healthy')
  })
})

describe('ArchDiagram', () => {
  it('renders the three regions as buttons across host/container/public + triggers', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('arch-diagram')).toBeInTheDocument()
    // a node from each region
    expect(screen.getByTestId('arch-node-trig-telegram')).toBeInTheDocument()
    expect(screen.getByTestId('arch-node-host-router')).toBeInTheDocument()
    expect(screen.getByTestId('arch-node-cont-orch')).toBeInTheDocument()
    expect(screen.getByTestId('arch-node-pub-api')).toBeInTheDocument()
  })

  it('reflects the derived status on the node (probed lights up, structural does not)', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
    expect(screen.getByTestId('arch-node-cont-portkey')).toHaveAttribute('data-status', 'structural')
    expect(screen.getByTestId('arch-node-cont-runtime')).toHaveAttribute('data-status', 'healthy')
  })

  it('calls onSelect with the node when a node button is activated', () => {
    const onSelect = vi.fn()
    render(<ArchDiagram arch={ARCH} mode={MODE} selectedId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('arch-node-cont-orch'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'cont-orch' }))
  })

  it('renders the owner as an actor — no status suffix in its accessible name', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} selectedId={null} onSelect={() => {}} />)
    const owner = screen.getByTestId('arch-node-owner')
    expect(owner).toHaveAttribute('data-status', 'actor')
    expect(owner).toHaveAccessibleName('Jane Doe')
  })
})

describe('ModeBanner', () => {
  it('shows LIVE + the pause state when live', () => {
    render(<ModeBanner mode={MODE} />)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE')).toBeInTheDocument()
  })

  it('labels shadow mode honestly', () => {
    render(<ModeBanner mode={{ ...MODE, live_mode: false }} />)
    expect(screen.getByText('SHADOW')).toBeInTheDocument()
    expect(screen.getByText(/agents observe and draft/i)).toBeInTheDocument()
  })

  it('degrades to connecting when mode is null', () => {
    render(<ModeBanner mode={null} />)
    expect(screen.getByText(/connecting/i)).toBeInTheDocument()
  })
})

describe('Legend', () => {
  it('distinguishes live-probed from structural', () => {
    render(<Legend />)
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByText(/Structural — no live probe/)).toBeInTheDocument()
  })
})

describe('NodePanel', () => {
  it('renders nothing when no node is selected', () => {
    const { container } = render(
      <NodePanel node={null} status="structural" arch={ARCH} mode={MODE} onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows live facts + a code link for a probed node', () => {
    render(<NodePanel node={byId('cont-runtime')} status="healthy" arch={ARCH} mode={MODE} onClose={() => {}} />)
    expect(screen.getByTestId('arch-node-panel')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('2 / 4')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /src\/container-runner\.ts/ })).toHaveAttribute(
      'href',
      expect.stringContaining('container-runner.ts'),
    )
  })

  it('shows the no-probe note for a structural node', () => {
    render(<NodePanel node={byId('cont-portkey')} status="structural" arch={ARCH} mode={MODE} onClose={() => {}} />)
    expect(screen.getByText(/deferred until the telemetry-capture work/i)).toBeInTheDocument()
  })

  it('shows an external doc link for a third-party node', () => {
    render(<NodePanel node={byId('cont-portkey')} status="structural" arch={ARCH} mode={MODE} onClose={() => {}} />)
    expect(screen.getByRole('link', { name: /Portkey Model Catalog/ })).toHaveAttribute(
      'href',
      expect.stringContaining('portkey.ai'),
    )
  })

  it('closes on the close button and Escape', () => {
    const onClose = vi.fn()
    render(<NodePanel node={byId('host-router')} status="healthy" arch={ARCH} mode={MODE} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
