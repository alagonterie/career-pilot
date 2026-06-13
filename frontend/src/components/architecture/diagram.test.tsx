import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ArchitectureData, SystemMode } from '~/lib/use-architecture'
import type { Observability, ProviderStat, ProviderStatus } from '~/lib/use-observability'

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

function provider(name: string, status: ProviderStatus, over: Partial<ProviderStat> = {}): ProviderStat {
  return {
    provider: name,
    requests_24h: 2,
    errors_24h: status === 'down' ? 2 : 0,
    error_rate: status === 'down' ? 1 : 0,
    last_success_age_sec: status === 'down' ? null : 200,
    p50_ms: 200,
    status,
    ...over,
  }
}

const ALL_PROVIDERS = ['gmail', 'calendar', 'drive', 'serpapi', 'greenhouse', 'lever', 'portkey']
const OBS: Observability = {
  spend_by_class: {
    chat: { microusd_24h: 0, buckets: [] },
    ops: { microusd_24h: 0, buckets: [] },
    sandbox: { microusd_24h: 0, buckets: [] },
    host: { microusd_24h: 0, buckets: [] },
  },
  providers: ALL_PROVIDERS.map((p) =>
    p === 'portkey'
      ? provider(p, 'healthy', { requests_24h: 35, p50_ms: 300, last_success_age_sec: 120 })
      : provider(p, 'healthy'),
  ),
  session_topology: { chat: 2, ops: 1, sandbox: 1 },
}

function node(probe: ProbeKind): ArchNode {
  return { id: 't', label: 't', region: 'host', probe, description: '', x: 0, y: 0, w: 0, h: 0 }
}
function providerNode(providers: string[], aggregate?: 'worst' | 'gateway'): ArchNode {
  return { ...node('provider'), providers, providerAggregate: aggregate }
}
function obsWith(...providers: ProviderStat[]): Observability {
  return { ...OBS, providers }
}
function byId(id: string): ArchNode {
  const n = NODES.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('deriveNodeStatus (the honesty core)', () => {
  it('never paints a structural node', () => {
    expect(deriveNodeStatus(node('structural'), ARCH, MODE, OBS)).toBe('structural')
  })

  it('maps host pause-state to the traffic light', () => {
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'active' }, null)).toBe('healthy')
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'paused' }, null)).toBe('degraded')
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'halted' }, null)).toBe('down')
    expect(deriveNodeStatus(node('pause'), ARCH, { ...MODE, pause_state: 'killswitch' }, null)).toBe('down')
    expect(deriveNodeStatus(node('pause'), ARCH, null, null)).toBe('idle')
  })

  it('reads backend / container / sessions honestly', () => {
    expect(deriveNodeStatus(node('backend'), ARCH, MODE, null)).toBe('healthy')
    expect(deriveNodeStatus(node('backend'), null, MODE, null)).toBe('idle')
    expect(
      deriveNodeStatus(node('container'), { ...ARCH, containers: { ...ARCH.containers, runtime: 'down' } }, MODE, null),
    ).toBe('down')
    expect(
      deriveNodeStatus(node('container'), { ...ARCH, containers: { ...ARCH.containers, running: 0 } }, MODE, null),
    ).toBe('idle')
    expect(deriveNodeStatus(node('sessions'), { ...ARCH, sessions: { active: 0, running: 0 } }, MODE, null)).toBe(
      'idle',
    )
    expect(deriveNodeStatus(node('sessions'), ARCH, MODE, null)).toBe('healthy')
  })

  it('lights provider nodes from request telemetry (§24.69)', () => {
    const single = providerNode(['portkey'])
    // No obs / no rows for the provider → idle (honest: no recent call, no claim).
    expect(deriveNodeStatus(single, ARCH, MODE, null)).toBe('idle')
    expect(deriveNodeStatus(single, ARCH, MODE, obsWith())).toBe('idle')
    expect(deriveNodeStatus(single, ARCH, MODE, obsWith(provider('portkey', 'healthy')))).toBe('healthy')
    expect(deriveNodeStatus(single, ARCH, MODE, obsWith(provider('portkey', 'degraded')))).toBe('degraded')
    expect(deriveNodeStatus(single, ARCH, MODE, obsWith(provider('portkey', 'down')))).toBe('down')
  })

  it('worst-of folds a multi-provider node (Google/jobs)', () => {
    const google = providerNode(['gmail', 'calendar', 'drive'])
    expect(
      deriveNodeStatus(google, ARCH, MODE, obsWith(provider('gmail', 'healthy'), provider('calendar', 'healthy'))),
    ).toBe('healthy')
    // One sub-provider down ⇒ the whole service node reads down (worst-of).
    expect(
      deriveNodeStatus(google, ARCH, MODE, obsWith(provider('gmail', 'down'), provider('calendar', 'healthy'))),
    ).toBe('down')
  })

  it('gateway-folds the OneCLI node: down only when EVERY provider is down', () => {
    const gw = providerNode(['gmail', 'portkey'], 'gateway')
    // One down, one healthy → the gateway is up but impaired → degraded.
    expect(deriveNodeStatus(gw, ARCH, MODE, obsWith(provider('gmail', 'down'), provider('portkey', 'healthy')))).toBe(
      'degraded',
    )
    // Everything down → the gateway itself is down.
    expect(deriveNodeStatus(gw, ARCH, MODE, obsWith(provider('gmail', 'down'), provider('portkey', 'down')))).toBe(
      'down',
    )
    expect(
      deriveNodeStatus(gw, ARCH, MODE, obsWith(provider('gmail', 'healthy'), provider('portkey', 'healthy'))),
    ).toBe('healthy')
  })
})

describe('ArchDiagram', () => {
  it('renders the three regions as buttons across host/container/public + triggers', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} obs={OBS} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('arch-diagram')).toBeInTheDocument()
    // a node from each region
    expect(screen.getByTestId('arch-node-trig-telegram')).toBeInTheDocument()
    expect(screen.getByTestId('arch-node-host-router')).toBeInTheDocument()
    expect(screen.getByTestId('arch-node-cont-orch')).toBeInTheDocument()
    expect(screen.getByTestId('arch-node-pub-api')).toBeInTheDocument()
  })

  it('reflects the derived status on the node (probed lights up, structural does not)', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} obs={OBS} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
    // cont-portkey is now a provider node, lit healthy by the seeded telemetry.
    expect(screen.getByTestId('arch-node-cont-portkey')).toHaveAttribute('data-status', 'healthy')
    expect(screen.getByTestId('arch-node-cont-runtime')).toHaveAttribute('data-status', 'healthy')
    // cont-anthropic stays honestly structural (we probe Portkey, not Anthropic directly).
    expect(screen.getByTestId('arch-node-cont-anthropic')).toHaveAttribute('data-status', 'structural')
  })

  it('lights the integration nodes from telemetry when obs is absent reads idle', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} obs={null} selectedId={null} onSelect={() => {}} />)
    // No obs yet → provider nodes read idle (no health claim), not a fake green.
    expect(screen.getByTestId('arch-node-cont-portkey')).toHaveAttribute('data-status', 'idle')
    expect(screen.getByTestId('arch-node-host-onecli')).toHaveAttribute('data-status', 'idle')
  })

  it('calls onSelect with the node when a node button is activated', () => {
    const onSelect = vi.fn()
    render(<ArchDiagram arch={ARCH} mode={MODE} obs={OBS} selectedId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('arch-node-cont-orch'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'cont-orch' }))
  })

  it('lights the §24.63 integration nodes (OneCLI gateway + the aliased jobs API) from telemetry', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} obs={OBS} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('arch-node-host-onecli')).toHaveAttribute('data-status', 'healthy')
    expect(screen.getByTestId('arch-node-cont-jobs')).toHaveAttribute('data-status', 'healthy')
  })

  it('renders the owner as an actor — no status suffix in its accessible name', () => {
    render(<ArchDiagram arch={ARCH} mode={MODE} obs={OBS} selectedId={null} onSelect={() => {}} />)
    const owner = screen.getByTestId('arch-node-owner')
    expect(owner).toHaveAttribute('data-status', 'actor')
    expect(owner).toHaveAccessibleName('Jane Doe')
  })
})

describe('ModeBanner', () => {
  it('shows LIVE + the agent state as what it MEANS (active → RUNNING)', () => {
    render(<ModeBanner mode={MODE} />)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    // pause_state 'active' renders as "RUNNING" under an "Agents" label, not the
    // contradictory "Pause: ACTIVE".
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument()
  })

  it('relabels the rest of the kill-switch ladder', () => {
    const { rerender } = render(<ModeBanner mode={{ ...MODE, pause_state: 'paused' }} />)
    expect(screen.getByText('PAUSED')).toBeInTheDocument()
    rerender(<ModeBanner mode={{ ...MODE, pause_state: 'halted' }} />)
    expect(screen.getByText('HALTED')).toBeInTheDocument()
  })

  it('explains the mode via a tap InfoTip (not a hover-only title)', () => {
    render(<ModeBanner mode={{ ...MODE, live_mode: false }} />)
    expect(screen.getByText('SHADOW')).toBeInTheDocument()
    // The explainer is in an InfoTip — present only after tapping its trigger.
    expect(screen.queryByText(/observe and draft/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'About: Mode' }))
    expect(screen.getByTestId('info-tip-panel')).toHaveTextContent(/observe and draft/i)
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
      <NodePanel node={null} status="structural" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows live facts + a code link for a probed node', () => {
    render(
      <NodePanel node={byId('cont-runtime')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    expect(screen.getByTestId('arch-node-panel')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('2 / 4')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /src\/container-runner\.ts/ })).toHaveAttribute(
      'href',
      expect.stringContaining('container-runner.ts'),
    )
  })

  it('shows the no-probe note for a still-structural node', () => {
    // cont-anthropic stays structural (we probe the Portkey gateway, not Anthropic).
    render(
      <NodePanel
        node={byId('cont-anthropic')}
        status="structural"
        arch={ARCH}
        mode={MODE}
        obs={OBS}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/no live health probe/i)).toBeInTheDocument()
    expect(screen.getByText(/stay honest structure/i)).toBeInTheDocument()
  })

  it('shows aggregate provider facts for a lit integration node (§24.69)', () => {
    render(
      <NodePanel node={byId('cont-portkey')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    expect(screen.getByText('Requests 24h')).toBeInTheDocument()
    expect(screen.getByText('35')).toBeInTheDocument() // portkey requests
    expect(screen.getByText('Error rate')).toBeInTheDocument()
    expect(screen.getByText('Last success')).toBeInTheDocument()
    expect(screen.getByText('p50 latency')).toBeInTheDocument()
    // Aggregate-only — no raw error text or session id leaks into the modal.
    expect(screen.queryByText(/invalid_grant|sess-/i)).toBeNull()
  })

  it('shows session topology in the Orchestrator modal (§24.69 / §24.67)', () => {
    render(<NodePanel node={byId('cont-orch')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />)
    expect(screen.getByText('By class')).toBeInTheDocument()
    expect(screen.getByText('chat 2 · ops 1 · sandbox 1')).toBeInTheDocument()
  })

  it('shows an external doc link for a third-party node', () => {
    render(
      <NodePanel node={byId('cont-portkey')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    expect(screen.getByRole('link', { name: /Portkey Model Catalog/ })).toHaveAttribute(
      'href',
      expect.stringContaining('portkey.ai'),
    )
  })

  it('links the OneCLI node to its public GitHub repo and is honest about the inheritance', () => {
    render(
      <NodePanel node={byId('host-onecli')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    expect(screen.getByRole('link', { name: /OneCLI on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/onecli/onecli',
    )
    expect(screen.getByText(/inherited with the NanoClaw fork/i)).toBeInTheDocument()
  })

  it('keeps the jobs-API node vendor-aliased (the §24.63 D1 decision)', () => {
    const jobs = byId('cont-jobs')
    expect(`${jobs.label} ${jobs.description}`).not.toMatch(/serpapi/i)
    // Quality bar still holds without naming the vendor: a resolving source link.
    render(<NodePanel node={jobs} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />)
    expect(screen.getByRole('link', { name: /scrape-jobs\.ts/ })).toBeInTheDocument()
  })

  it('anchors the orchestrator source in the agent-runner tree, not the host provider config (§24.63)', () => {
    expect(byId('cont-orch').source).toBe('container/agent-runner/src/providers/claude.ts')
  })

  it('gives the edge node the Worker-proxy source link (the D12 public path)', () => {
    render(
      <NodePanel node={byId('pub-edge')} status="structural" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    expect(screen.getByRole('link', { name: /routes\/api/ })).toBeInTheDocument()
    expect(screen.getByText(/browser talks only to the Worker/i)).toBeInTheDocument()
  })

  it('closes on the close button and Escape', () => {
    const onClose = vi.fn()
    render(
      <NodePanel node={byId('host-router')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('is a described, focus-managed dialog via the shared contract (§24.36 36.2)', () => {
    render(
      <NodePanel node={byId('host-router')} status="healthy" arch={ARCH} mode={MODE} obs={OBS} onClose={() => {}} />,
    )
    const panel = screen.getByTestId('arch-node-panel')
    // aria-describedby points at the node description (the tightened role=dialog).
    expect(panel).toHaveAttribute('aria-describedby', 'arch-node-desc')
    expect(document.getElementById('arch-node-desc')).toHaveTextContent(byId('host-router').description)
    // useDialog moves focus into the panel on open.
    expect(document.activeElement).toBe(panel)
  })

  it('renders the live sanitizer demo for the demo node (§24.35 Pass B)', async () => {
    // The pub-sanitize node carries demo:'sanitizer' → its modal hosts the live
    // demo (lazy fetch). Mock the POST so the body renders without a backend.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        raw: 'Email a@b.com',
        sanitized: 'Email [EMAIL_REDACTED]',
        redactions: 1,
        sample: 0,
        total: 3,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <NodePanel
        node={byId('pub-sanitize')}
        status="structural"
        arch={ARCH}
        mode={MODE}
        obs={OBS}
        onClose={() => {}}
      />,
    )
    expect(await screen.findByTestId('anon-sanitized')).toHaveTextContent('[EMAIL_REDACTED]')
    // the demo replaces the structural "no live probe" note on this node
    expect(screen.queryByText(/no live health probe/i)).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
