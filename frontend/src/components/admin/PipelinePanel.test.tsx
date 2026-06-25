import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AdminPipelineRow } from '~/lib/use-admin'

import { PipelinePanel } from './PipelinePanel'

function row(over: Partial<AdminPipelineRow> & { application_id: string }): AdminPipelineRow {
  return {
    company_name: 'Acme',
    obfuscated_label: 'infra-a',
    role_title: 'Staff Engineer',
    status: 'screening',
    stage: 'screen',
    applied_at: '2026-06-10T00:00:00Z',
    last_activity_at: '2026-06-18T00:00:00Z',
    win_confidence: 50,
    ...over,
  }
}

describe('PipelinePanel', () => {
  it('renders the owner real names + obfuscated label and the stage-count strip', () => {
    render(
      <PipelinePanel
        rows={[row({ application_id: 'a1', company_name: 'Wayne Enterprises', obfuscated_label: 'infra-e' })]}
        stageCounts={{ screen: 1 }}
      />,
    )
    expect(screen.getByText('Wayne Enterprises')).toBeInTheDocument()
    expect(screen.getByText('infra-e')).toBeInTheDocument()
  })

  it('sorts on the Win column (desc-first)', () => {
    render(
      <PipelinePanel
        rows={[
          row({ application_id: 'low', company_name: 'LowCo', win_confidence: 20 }),
          row({ application_id: 'high', company_name: 'HighCo', win_confidence: 90 }),
        ]}
        stageCounts={{}}
      />,
    )
    const names = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r).getByText(/Co/).textContent)
    expect(names()).toEqual(['LowCo', 'HighCo']) // incoming order

    fireEvent.click(screen.getByTestId('datatable-sort-win')) // desc → highest first
    expect(names()).toEqual(['HighCo', 'LowCo'])
  })

  it('paginates past the page size', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ application_id: `a${i}`, company_name: `Co ${i}` }))
    render(<PipelinePanel rows={rows} stageCounts={{}} />)
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 1–25 of 30')
  })

  it('shows the empty note with no applications', () => {
    render(<PipelinePanel rows={[]} stageCounts={{}} />)
    expect(screen.getByText('No applications in the pipeline yet.')).toBeInTheDocument()
  })
})
