import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Sparkline } from '~/components/Sparkline'
import type { Observability } from '~/lib/use-observability'

import { SpendByClassPanel } from './panels'

function zeros(): number[] {
  return new Array(24).fill(0)
}

function obs(over: Partial<Record<keyof Observability['spend_by_class'], number>> = {}): Observability {
  const lane = (microusd: number) => ({
    microusd_24h: microusd,
    buckets: zeros().map((_, i) => (i === 23 ? microusd : 0)),
  })
  return {
    spend_by_class: {
      chat: lane(over.chat ?? 0),
      ops: lane(over.ops ?? 0),
      sandbox: lane(over.sandbox ?? 0),
      host: lane(over.host ?? 0),
    },
    providers: [],
    session_topology: { chat: 0, ops: 0, sandbox: 0 },
  }
}

describe('SpendByClassPanel', () => {
  it('shows a skeleton while loading and offline on error', () => {
    const { rerender } = render(<SpendByClassPanel data={null} status="loading" />)
    expect(screen.getByTestId('panel-skeleton')).toBeTruthy()
    rerender(<SpendByClassPanel data={null} status="error" />)
    expect(screen.getByText(/offline/i)).toBeTruthy()
  })

  it('shows the pending copy when no spend was captured', () => {
    render(<SpendByClassPanel data={obs()} status="ok" />)
    expect(screen.getByTestId('spend-pending')).toBeTruthy()
    expect(screen.queryByTestId('spend-by-class')).toBeNull()
  })

  it('renders a row + sparkline per class with formatted dollars', () => {
    // chat: 5,000,000 µ = $5.00; host: 1,500 µ = $0.0015 (sub-cent → 4dp).
    render(<SpendByClassPanel data={obs({ chat: 5_000_000, host: 1_500 })} status="ok" />)
    expect(screen.getByTestId('spend-by-class')).toBeTruthy()
    expect(screen.getByTestId('spend-chat').textContent).toBe('$5.00')
    expect(screen.getByTestId('spend-host').textContent).toBe('$0.0015')
    expect(screen.getByTestId('spend-ops').textContent).toBe('$0.00')
    // One sparkline per class.
    for (const cls of ['chat', 'ops', 'sandbox', 'host']) {
      expect(screen.getByTestId(`spark-${cls}`).querySelector('polyline')).toBeTruthy()
    }
    // Total line: $5.00 + $0.0015 → rounds to $5.00 at 2dp.
    expect(screen.getByText(/across all classes/i)).toBeTruthy()
  })
})

describe('Sparkline', () => {
  it('renders a polyline with one vertex per value', () => {
    const { container } = render(<Sparkline values={[0, 5, 10, 3]} />)
    const poly = container.querySelector('polyline')
    expect(poly).toBeTruthy()
    expect(poly!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4)
  })

  it('draws a flat baseline when every value is zero (no NaN)', () => {
    const { container } = render(<Sparkline values={[0, 0, 0]} height={18} />)
    const pts = container.querySelector('polyline')!.getAttribute('points')!
    expect(pts).not.toContain('NaN')
    // All y-coords pinned to the bottom (height - pad = 17).
    for (const p of pts.trim().split(/\s+/)) expect(p.split(',')[1]).toBe('17.0')
  })

  it('returns nothing for an empty series', () => {
    const { container } = render(<Sparkline values={[]} />)
    expect(container.querySelector('svg')).toBeNull()
  })
})
