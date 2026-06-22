import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CompanyHandle, HandleChip } from './CompanyHandle'
import type { PipelineApplication } from '~/lib/use-pipeline'

const app = (over: Partial<PipelineApplication>): PipelineApplication =>
  ({ application_ref: 'fintech-b', public_state: 'obfuscated', ...over }) as PipelineApplication

describe('HandleChip (§24.153)', () => {
  it('renders the label as the shared anonymization chip with the explanatory title', () => {
    render(<HandleChip label="fintech-b" />)
    const chip = screen.getByText('fintech-b')
    expect(chip).toHaveAttribute('title', expect.stringContaining('anonymized'))
    // Illustrative uses opt OUT of the canonical testid so they don't inflate the
    // board's company-handle count.
    expect(chip).not.toHaveAttribute('data-testid')
  })

  it('carries the canonical company-handle testid only when a caller opts in', () => {
    render(<HandleChip label="infra-e" testId="company-handle" />)
    expect(screen.getByTestId('company-handle')).toHaveTextContent('infra-e')
  })
})

describe('CompanyHandle (§24.137)', () => {
  it('renders a live application as the obfuscated handle chip', () => {
    render(<CompanyHandle app={app({ application_ref: 'fintech-b', public_state: 'obfuscated' })} />)
    expect(screen.getByTestId('company-handle')).toHaveTextContent('fintech-b')
  })

  it('reveals the real name plainly once public — no chip', () => {
    render(<CompanyHandle app={app({ application_ref: 'Wayne Enterprises', public_state: 'public' })} />)
    expect(screen.getByText('Wayne Enterprises')).toBeInTheDocument()
    expect(screen.queryByTestId('company-handle')).not.toBeInTheDocument()
  })
})
