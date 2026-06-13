import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HealthReport } from '~/lib/use-dev-inspector'

import { HealthPanel } from './HealthPanel'

function report(findings: HealthReport['findings']): HealthReport {
  return { ranAt: '2026-06-12T18:00:00Z', findings }
}

describe('HealthPanel', () => {
  it('shows a loading state before the first report', () => {
    render(<HealthPanel report={null} />)
    expect(screen.getByText(/running checks/i)).toBeTruthy()
  })

  it('shows all-clear when only ok findings (no live probes here)', () => {
    render(
      <HealthPanel
        report={report([{ id: 'queue', severity: 'ok', title: 'Queue healthy', detail: 'no stale rows' }])}
      />,
    )
    expect(screen.getByTestId('health-all-clear')).toBeTruthy()
    expect(screen.getByTestId('health-summary-badge').textContent).toBe('all clear')
    expect(screen.queryByTestId('health-findings')).toBeNull()
  })

  it('renders non-ok findings worst-first with their next_step runbook command', () => {
    render(
      <HealthPanel
        report={report([
          { id: 'orphan-responses:s1', severity: 'warn', title: 'Orphan responses', detail: '30 pending' },
          {
            id: 'auth-failure:gmail',
            severity: 'critical',
            title: 'Gmail auth failing',
            detail: '401 in the last 24h',
            next_step: 'reconnect Gmail via OneCLI; check consent-screen publish status',
          },
          { id: 'queue', severity: 'ok', title: 'Queue healthy', detail: 'fine' },
        ])}
      />,
    )
    // Summary badge reflects the worst severity present.
    expect(screen.getByTestId('health-summary-badge').textContent).toBe('1 critical')
    // ok finding is not listed; the two non-ok ones are.
    const items = screen.getByTestId('health-findings').querySelectorAll('li')
    expect(items).toHaveLength(2)
    // Critical sorts first.
    expect(items[0].getAttribute('data-testid')).toBe('health-finding-auth-failure:gmail')
    // next_step rendered verbatim as a copy-pasteable block.
    expect(screen.getByTestId('health-next-step-auth-failure:gmail').textContent).toContain(
      'reconnect Gmail via OneCLI',
    )
    // A warn without next_step still renders, just no command block.
    expect(screen.getByTestId('health-finding-orphan-responses:s1')).toBeTruthy()
    expect(screen.queryByTestId('health-next-step-orphan-responses:s1')).toBeNull()
  })

  it('summarizes warns when there are warns but no criticals', () => {
    render(
      <HealthPanel
        report={report([{ id: 'stale-surface:gmail', severity: 'warn', title: 'Stale surface', detail: 'old' }])}
      />,
    )
    expect(screen.getByTestId('health-summary-badge').textContent).toBe('1 warn')
  })
})
