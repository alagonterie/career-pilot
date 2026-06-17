import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MultiSparkline, Sparkline } from '~/components/Sparkline'
import type { Observability } from '~/lib/use-observability'

import { LlmSpendPanel } from './panels'

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

describe('LlmSpendPanel', () => {
  it('shows a skeleton while loading and offline on error', () => {
    const { rerender } = render(<LlmSpendPanel data={null} status="loading" />)
    expect(screen.getByTestId('panel-skeleton')).toBeTruthy()
    rerender(<LlmSpendPanel data={null} status="error" />)
    expect(screen.getByText(/offline/i)).toBeTruthy()
  })

  it('shows the pending copy when no spend was captured', () => {
    render(<LlmSpendPanel data={obs()} status="ok" />)
    expect(screen.getByTestId('spend-pending')).toBeTruthy()
    expect(screen.queryByTestId('spend-by-class')).toBeNull()
  })

  it('renders the total headline + combined chart + a legend $ per class', () => {
    // chat: 5,000,000 µ = $5.00; host: 1,500 µ = $0.0015 (sub-cent → 4dp).
    const { container } = render(<LlmSpendPanel data={obs({ chat: 5_000_000, host: 1_500 })} status="ok" />)
    expect(screen.getByTestId('spend-by-class')).toBeTruthy()
    // Total headline: $5.00 + $0.0015 → rounds to $5.00 at 2dp.
    expect(screen.getByTestId('llm-spend-total').textContent).toBe('$5.00')
    expect(screen.getByTestId('spend-chat').textContent).toBe('$5.00')
    expect(screen.getByTestId('spend-host').textContent).toBe('$0.0015')
    expect(screen.getByTestId('spend-ops').textContent).toBe('$0.00')
    // ONE overlaid chart with a line per class (4 polylines, shared scale).
    expect(screen.getByTestId('spend-chart').querySelectorAll('polyline')).toHaveLength(4)
    // Every class has its LITERAL dot color — incl. bg-accent-cool, which a
    // derived 'text-'→'bg-' replace dropped (Tailwind only emits literal classes).
    for (const dot of ['bg-primary', 'bg-accent-cool', 'bg-warn', 'bg-muted-foreground']) {
      expect(container.querySelector(`.${dot}`)).toBeTruthy()
    }
    // §24.109 #11: each legend row carries a lightweight title-style tooltip
    // explaining its traffic class (one per class).
    const tipped = container.querySelectorAll('li[title]')
    expect(tipped).toHaveLength(4)
    expect(Array.from(tipped).some((li) => /owner chats/i.test(li.getAttribute('title') ?? ''))).toBe(true)
  })

  it('shows the cache rate as an equal-sized amount (a cost lever) only when passed, with its InfoTip', () => {
    const { rerender } = render(<LlmSpendPanel data={obs({ chat: 1_000_000 })} status="ok" />)
    expect(screen.queryByText('cache')).toBeNull() // no rate → no amount
    rerender(<LlmSpendPanel data={obs({ chat: 1_000_000 })} cacheHitRate={0.9} status="ok" />)
    expect(screen.getByText('cache')).toBeTruthy()
    // §24.84: cache is now a full Metric, the SAME big-number size as the 24h spend.
    const cache = screen.getByTestId('llm-cache-rate')
    expect(cache.textContent).toBe('90%')
    expect(cache.className).toContain('text-2xl')
    expect(screen.getByTestId('llm-spend-total').className).toContain('text-2xl')
    expect(screen.getByLabelText('About: cache')).toBeTruthy()
  })
})

describe('MultiSparkline', () => {
  it('overlays one polyline per series on a shared y-scale', () => {
    const { container } = render(
      <MultiSparkline
        series={[
          { values: [0, 10, 0], className: 'text-primary' },
          { values: [0, 5, 0], className: 'text-warn' },
        ]}
      />,
    )
    const lines = container.querySelectorAll('polyline')
    expect(lines).toHaveLength(2)
    // Shared max (10): the 2nd series' peak (5) sits at the vertical midpoint,
    // not at the top — proof the scale is shared, not per-series.
    const peakY = (poly: Element) => Number(poly.getAttribute('points')!.trim().split(/\s+/)[1].split(',')[1])
    expect(peakY(lines[1])).toBeGreaterThan(peakY(lines[0]))
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
