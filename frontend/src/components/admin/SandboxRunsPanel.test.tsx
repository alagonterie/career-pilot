import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { AdminSandboxRun, AdminSandboxRunsView } from '~/lib/use-admin'

import { SandboxRunsPanel } from './SandboxRunsPanel'

// SandboxRunsPanel renders a <Link>, so it needs a router context. A thin stub
// keeps the test from pulling the whole route tree.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, params: _params, ...props }: { children: ReactNode; to?: string; params?: unknown }) => (
    <a {...props}>{children}</a>
  ),
}))

const ok = async () => ({ ok: true as const, status: 200 })

function run(p: Partial<AdminSandboxRun> & { id: string }): AdminSandboxRun {
  return {
    id: p.id,
    ts: p.ts ?? '2026-06-23T17:00:00.000Z',
    visitor_company: p.visitor_company ?? 'Globex',
    visitor_role: p.visitor_role ?? 'Staff SWE',
    jd_excerpt: p.jd_excerpt ?? null,
    total_cost_cents: p.total_cost_cents ?? 84,
    total_latency_ms: p.total_latency_ms ?? 153000,
    status: p.status ?? 'completed',
    expires_at: p.expires_at ?? null,
    ip_token: p.ip_token ?? 'abcdef0123456789',
  }
}

const VIEW: AdminSandboxRunsView = {
  runs: [run({ id: 'sb-1', visitor_company: 'Globex', jd_excerpt: 'Build the reconciliation service' })],
  stats: { total: 5, runsToday: 2, costTodayCents: 168, runs7d: 4 },
}

describe('SandboxRunsPanel', () => {
  it('renders the aggregate header + the owner detail (company/role/cost), and never the raw IP', () => {
    render(<SandboxRunsPanel data={VIEW} onDelete={ok} />)
    expect(screen.getByText('Globex')).toBeInTheDocument()
    expect(screen.getByText('Staff SWE')).toBeInTheDocument()
    expect(screen.getByText('$0.84')).toBeInTheDocument() // 84 cents
    expect(screen.getByText('2m 33s')).toBeInTheDocument() // 153000ms
    // the source token is truncated; the full token / a raw IP never renders
    expect(screen.queryByText('abcdef0123456789')).not.toBeInTheDocument()
    expect(screen.getByText('abcdef')).toBeInTheDocument()
  })

  it('shows an empty state with no rows', () => {
    render(<SandboxRunsPanel data={{ runs: [], stats: VIEW.stats }} onDelete={ok} />)
    expect(screen.getByText(/No sandbox runs stored/i)).toBeInTheDocument()
  })

  it('reveals the JD excerpt + the result link on Details', () => {
    render(<SandboxRunsPanel data={VIEW} onDelete={ok} />)
    expect(screen.queryByText(/Build the reconciliation service/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('sandbox-run-details-sb-1'))
    expect(screen.getByText(/Build the reconciliation service/)).toBeInTheDocument()
    expect(screen.getByText(/Open the result page/)).toBeInTheDocument()
  })

  it('confirm-gates delete and calls onDelete with the run id', async () => {
    const onDelete = vi.fn(ok)
    render(<SandboxRunsPanel data={VIEW} onDelete={onDelete} />)
    fireEvent.click(screen.getByTestId('sandbox-run-delete-sb-1')) // arms the confirm
    expect(onDelete).not.toHaveBeenCalled()
    const confirm = screen.getByTestId('sandbox-run-confirm-sb-1')
    fireEvent.click(within(confirm).getByTestId('sandbox-run-delete-yes-sb-1'))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('sb-1'))
  })
})
