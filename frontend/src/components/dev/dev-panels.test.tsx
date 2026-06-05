import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DevKnob, DevPersonaResponse, DevStateResponse } from '~/lib/use-dev-inspector'

import { KnobControls } from './KnobControls'
import { PersonaPanel } from './PersonaPanel'
import { SimStatePanel } from './SimStatePanel'

function knob(p: Partial<DevKnob> & { key: string; type: DevKnob['type']; group: DevKnob['group'] }): DevKnob {
  return {
    value: p.type === 'boolean' ? false : p.type === 'number' ? 1 : '* * * * *',
    label: p.key,
    min: null,
    max: null,
    integer: false,
    note: null,
    ...p,
  }
}

const KNOBS: DevKnob[] = [
  knob({ key: 'recruiter_sim_enabled', type: 'boolean', group: 'sim', value: false, label: 'Sim enabled' }),
  knob({
    key: 'recruiter_sim_max_concurrent',
    type: 'number',
    group: 'sim',
    value: 8,
    min: 0,
    max: 100,
    integer: true,
    label: 'Max concurrent',
  }),
  knob({
    key: 'funnel_curator_cron',
    type: 'cron',
    group: 'pacing',
    value: '30 7 * * *',
    label: 'Funnel cron',
    note: 'applies next cycle',
  }),
]

describe('KnobControls', () => {
  it('renders one card per group present', () => {
    render(<KnobControls knobs={KNOBS} onWrite={vi.fn(async () => ({ ok: true, status: 200 }))} />)
    expect(screen.getByTestId('knob-group-sim')).toBeInTheDocument()
    expect(screen.getByTestId('knob-group-pacing')).toBeInTheDocument()
    expect(screen.queryByTestId('knob-group-polling')).not.toBeInTheDocument()
  })

  it('toggling a boolean writes the flipped value', async () => {
    const onWrite = vi.fn(async () => ({ ok: true, status: 200 }))
    render(<KnobControls knobs={KNOBS} onWrite={onWrite} />)
    const sw = within(screen.getByTestId('knob-recruiter_sim_enabled')).getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('recruiter_sim_enabled', true))
  })

  it('committing a number input writes the value on blur', async () => {
    const onWrite = vi.fn(async () => ({ ok: true, status: 200 }))
    render(<KnobControls knobs={KNOBS} onWrite={onWrite} />)
    const input = within(screen.getByTestId('knob-recruiter_sim_max_concurrent')).getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.blur(input)
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('recruiter_sim_max_concurrent', 3))
  })

  it('does not write a number outside the knob range', async () => {
    const onWrite = vi.fn(async () => ({ ok: true, status: 200 }))
    render(<KnobControls knobs={KNOBS} onWrite={onWrite} />)
    const input = within(screen.getByTestId('knob-recruiter_sim_max_concurrent')).getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '999' } }) // > max 100
    fireEvent.blur(input)
    // give any pending microtask a chance, then assert no write happened
    await Promise.resolve()
    expect(onWrite).not.toHaveBeenCalled()
  })

  it('committing a cron input writes the string', async () => {
    const onWrite = vi.fn(async () => ({ ok: true, status: 200 }))
    render(<KnobControls knobs={KNOBS} onWrite={onWrite} />)
    const input = within(screen.getByTestId('knob-funnel_curator_cron')).getByRole('textbox')
    fireEvent.change(input, { target: { value: '*/5 * * * *' } })
    fireEvent.blur(input)
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('funnel_curator_cron', '*/5 * * * *'))
  })

  it('reverts and shows the error when a write is rejected', async () => {
    const onWrite = vi.fn(async () => ({ ok: false, status: 400, error: 'must be ≤ 100' }))
    render(<KnobControls knobs={KNOBS} onWrite={onWrite} />)
    const sw = within(screen.getByTestId('knob-recruiter_sim_enabled')).getByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(screen.getByText('must be ≤ 100')).toBeInTheDocument())
    expect(sw).toHaveAttribute('aria-checked', 'false') // reverted
  })
})

describe('SimStatePanel', () => {
  const state: DevStateResponse = {
    enabled: true,
    lastSeedAtMs: Date.now(),
    apps: [
      {
        appId: 'sim-1',
        company: 'Meridian Labs',
        role: 'Senior Software Engineer',
        obfuscatedLabel: 'ai-a',
        threadId: 't1',
        stageIndex: 2,
        status: 'active',
        outcome: null,
        nextFireAtMs: Date.now() + 120000,
      },
    ],
    applications: [
      {
        id: 'sim-1',
        company_name: 'Meridian Labs',
        obfuscated_label: 'ai-a',
        role_title: 'Senior Software Engineer',
        status: 'screening',
        applied_at: '2026-05-09T00:00:00Z',
        last_activity_at: null,
      },
    ],
  }

  it('shows the enabled badge + a row joining sim app to its DB status', () => {
    render(<SimStatePanel state={state} />)
    expect(screen.getByTestId('sim-enabled-badge')).toHaveTextContent('running')
    const row = screen.getByTestId('sim-app-sim-1')
    expect(within(row).getByText('Meridian Labs')).toBeInTheDocument()
    expect(within(row).getByText('screening')).toBeInTheDocument() // joined DB status
  })

  it('renders an empty hint when no apps are in flight', () => {
    render(<SimStatePanel state={{ enabled: false, lastSeedAtMs: 0, apps: [], applications: [] }} />)
    expect(screen.getByTestId('sim-enabled-badge')).toHaveTextContent('idle')
    expect(screen.getByText(/No simulated applications/i)).toBeInTheDocument()
  })
})

describe('PersonaPanel', () => {
  it('shows onboarding mode (next: full_name) + the sentinel for an empty profile', () => {
    const persona: DevPersonaResponse = {
      profile: null,
      candidateMd: '# Onboarding mode\n\nNo candidate profile yet.',
      onboarding: {
        fields: [
          { field: 'full_name', filled: false },
          { field: 'target_roles', filled: false },
          { field: 'comp_floor', filled: false },
          { field: 'master_resume', filled: false },
          { field: 'bio', filled: false },
          { field: 'why_this_exists', filled: false },
        ],
        filledCount: 0,
        totalCount: 6,
        complete: false,
        nextField: 'full_name',
      },
    }
    render(<PersonaPanel persona={persona} />)
    expect(screen.getByTestId('onboarding-badge')).toHaveTextContent('0/6')
    expect(within(screen.getByTestId('onboarding-full_name')).getByText('← next')).toBeInTheDocument()
    expect(screen.getByTestId('candidate-md')).toHaveTextContent('Onboarding mode')
  })

  it('renders the real profile fields when populated', () => {
    const persona: DevPersonaResponse = {
      profile: {
        full_name: 'Jane Doe',
        display_name: null,
        bio: 'Backend engineer.',
        target_roles: '["Backend Engineer","Platform Engineer"]',
        comp_floor: 180000,
        master_resume: 'EXPERIENCE\n- thing',
        skills: '["Go","TypeScript"]',
        github_url: 'https://github.com/example',
        linkedin_url: null,
        x_url: null,
        website_url: null,
        why_this_exists: 'because',
        gmail_account: 'candidate.dev@gmail.com',
        updated_at: '2026-06-05T00:00:00Z',
      },
      candidateMd: '# Jane Doe',
      onboarding: {
        fields: [
          { field: 'full_name', filled: true },
          { field: 'target_roles', filled: true },
          { field: 'comp_floor', filled: true },
          { field: 'master_resume', filled: true },
          { field: 'bio', filled: true },
          { field: 'why_this_exists', filled: true },
        ],
        filledCount: 6,
        totalCount: 6,
        complete: true,
        nextField: null,
      },
    }
    render(<PersonaPanel persona={persona} />)
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Backend Engineer, Platform Engineer')).toBeInTheDocument()
    expect(screen.getByText('$180,000')).toBeInTheDocument()
    expect(screen.getByTestId('onboarding-badge')).toHaveTextContent('6/6')
  })
})
