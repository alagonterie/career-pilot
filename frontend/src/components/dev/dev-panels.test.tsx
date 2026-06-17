import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DevKnob, DevPersonaResponse, DevStateResponse } from '~/lib/use-dev-inspector'

import { KnobControls } from './KnobControls'
import { PauseSpendControl } from './PauseSpendControl'
import { PersonaPanel } from './PersonaPanel'
import { ResetControl } from './ResetControl'
import { SimStatePanel } from './SimStatePanel'

const ok = async () => ({ ok: true as const, status: 200 })

function knob(p: Partial<DevKnob> & { key: string; type: DevKnob['type']; group: DevKnob['group'] }): DevKnob {
  const value =
    p.value ??
    (p.type === 'boolean'
      ? false
      : p.type === 'number'
        ? 1
        : p.type === 'enum'
          ? (p.options?.[0] ?? 'default')
          : '* * * * *')
  return {
    key: p.key,
    type: p.type,
    group: p.group,
    value,
    default: p.default ?? value,
    overridden: p.overridden ?? false,
    label: p.label ?? p.key,
    min: p.min ?? null,
    max: p.max ?? null,
    integer: p.integer ?? false,
    options: p.options ?? null,
    note: p.note ?? null,
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
    label: 'Pipeline cron',
    note: 'applies next cycle',
  }),
  knob({
    key: 'dev_model_tier',
    type: 'enum',
    group: 'models',
    value: 'default',
    options: ['default', 'sonnet', 'haiku'],
    label: 'Dev model tier',
  }),
]

const OVERRIDDEN_KNOBS: DevKnob[] = [
  knob({
    key: 'recruiter_sim_max_concurrent',
    type: 'number',
    group: 'sim',
    value: 2,
    default: 8,
    overridden: true,
    min: 0,
    max: 100,
    integer: true,
    label: 'Max concurrent',
  }),
]

function renderControls(knobs: DevKnob[], overrides: Partial<Parameters<typeof KnobControls>[0]> = {}) {
  return render(<KnobControls knobs={knobs} onWrite={ok} onReset={ok} onResetAll={ok} {...overrides} />)
}

describe('KnobControls', () => {
  it('renders one card per group present', () => {
    renderControls(KNOBS)
    expect(screen.getByTestId('knob-group-sim')).toBeInTheDocument()
    expect(screen.getByTestId('knob-group-pacing')).toBeInTheDocument()
    expect(screen.getByTestId('knob-group-models')).toBeInTheDocument()
    expect(screen.queryByTestId('knob-group-polling')).not.toBeInTheDocument()
  })

  it('picking a model tier option commits the selected value AND optimistically activates it', async () => {
    const onWrite = vi.fn(ok)
    renderControls(KNOBS, { onWrite })
    const row = screen.getByTestId('knob-dev_model_tier')
    expect(within(row).getByTestId('knob-option-dev_model_tier-default')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(row).getByTestId('knob-option-dev_model_tier-haiku'))
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('dev_model_tier', 'haiku'))
    expect(within(row).getByTestId('knob-option-dev_model_tier-haiku')).toHaveAttribute('aria-checked', 'true')
  })

  it('toggling a boolean writes the flipped value AND optimistically flips the control', async () => {
    const onWrite = vi.fn(ok)
    renderControls(KNOBS, { onWrite })
    const sw = within(screen.getByTestId('knob-recruiter_sim_enabled')).getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    // The fix: the toggle reflects ON immediately (optimistic), not only after a poll.
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    expect(onWrite).toHaveBeenCalledWith('recruiter_sim_enabled', true)
  })

  it('committing a number input writes the value on blur', async () => {
    const onWrite = vi.fn(ok)
    renderControls(KNOBS, { onWrite })
    const input = within(screen.getByTestId('knob-recruiter_sim_max_concurrent')).getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.blur(input)
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('recruiter_sim_max_concurrent', 3))
  })

  it('does not write a number outside the knob range', async () => {
    const onWrite = vi.fn(ok)
    renderControls(KNOBS, { onWrite })
    const input = within(screen.getByTestId('knob-recruiter_sim_max_concurrent')).getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '999' } }) // > max 100
    fireEvent.blur(input)
    await Promise.resolve()
    expect(onWrite).not.toHaveBeenCalled()
  })

  it('committing a cron input writes the string', async () => {
    const onWrite = vi.fn(ok)
    renderControls(KNOBS, { onWrite })
    const input = within(screen.getByTestId('knob-funnel_curator_cron')).getByRole('textbox')
    fireEvent.change(input, { target: { value: '*/5 * * * *' } })
    fireEvent.blur(input)
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('funnel_curator_cron', '*/5 * * * *'))
  })

  it('reverts and shows the error when a write is rejected', async () => {
    const onWrite = vi.fn(async () => ({ ok: false as const, status: 400, error: 'must be ≤ 100' }))
    renderControls(KNOBS, { onWrite })
    const sw = within(screen.getByTestId('knob-recruiter_sim_enabled')).getByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(screen.getByText('must be ≤ 100')).toBeInTheDocument())
    expect(sw).toHaveAttribute('aria-checked', 'false') // reverted
  })

  it('shows a per-knob reset only when overridden, and resets to the default on click', async () => {
    const onReset = vi.fn(ok)
    // not overridden → no reset button
    const { unmount } = renderControls(KNOBS)
    expect(screen.queryByTestId('knob-reset-recruiter_sim_max_concurrent')).not.toBeInTheDocument()
    unmount()

    // overridden → reset button resets the control to the default (8)
    renderControls(OVERRIDDEN_KNOBS, { onReset })
    const input = within(screen.getByTestId('knob-recruiter_sim_max_concurrent')).getByRole('spinbutton')
    expect(input).toHaveValue(2)
    fireEvent.click(screen.getByTestId('knob-reset-recruiter_sim_max_concurrent'))
    await waitFor(() => expect(onReset).toHaveBeenCalledWith('recruiter_sim_max_concurrent'))
    expect(input).toHaveValue(8) // optimistic reset to default
  })

  it('the "All to defaults" button is disabled until something is overridden', async () => {
    const onResetAll = vi.fn(ok)
    const { unmount } = renderControls(KNOBS, { onResetAll }) // none overridden
    expect(screen.getByTestId('reset-all')).toBeDisabled()
    unmount()

    renderControls(OVERRIDDEN_KNOBS, { onResetAll })
    const btn = screen.getByTestId('reset-all')
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    await waitFor(() => expect(onResetAll).toHaveBeenCalled())
  })
})

describe('SimStatePanel', () => {
  const state: DevStateResponse = {
    enabled: true,
    lastSeedAtMs: Date.now(),
    pauseState: 'active',
    apps: [
      {
        appId: 'sim-1',
        company: 'Meridian Labs',
        role: 'Senior Software Engineer',
        obfuscatedLabel: 'ai-a',
        threadId: 't1',
        stageIndex: 2,
        totalStages: 4,
        upcoming: 'onsite_invite',
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

  it('shows the enabled badge + a row joining sim app to its DB status + what is queued next', () => {
    render(<SimStatePanel state={state} />)
    expect(screen.getByTestId('sim-enabled-badge')).toHaveTextContent('running')
    const row = screen.getByTestId('sim-app-sim-1')
    expect(within(row).getByText('Meridian Labs')).toBeInTheDocument()
    expect(within(row).getByText('screening')).toBeInTheDocument() // joined DB status
    // "Next up": the queued classification + an ETA for an active app.
    expect(screen.getByTestId('sim-next-sim-1')).toHaveTextContent('onsite_invite')
  })

  it('renders an empty hint when no apps are in flight', () => {
    render(
      <SimStatePanel state={{ enabled: false, lastSeedAtMs: 0, pauseState: 'active', apps: [], applications: [] }} />,
    )
    expect(screen.getByTestId('sim-enabled-badge')).toHaveTextContent('idle')
    expect(screen.getByText(/No simulated applications/i)).toBeInTheDocument()
  })

  it('shows a "Sweep & convert now" button when onSweep is provided + reports the enqueue', async () => {
    const onSweep = vi.fn(ok)
    render(<SimStatePanel state={state} onSweep={onSweep} />)
    fireEvent.click(screen.getByTestId('sweep-now'))
    await waitFor(() => expect(onSweep).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('sweep-status')).toHaveTextContent(/converted/i))
  })

  it('omits the sweep button when onSweep is not provided', () => {
    render(<SimStatePanel state={state} />)
    expect(screen.queryByTestId('sweep-now')).not.toBeInTheDocument()
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
          { field: 'location_pref', filled: false },
          { field: 'master_resume', filled: false },
          { field: 'bio', filled: false },
          { field: 'why_this_exists', filled: false },
        ],
        filledCount: 0,
        totalCount: 7,
        complete: false,
        nextField: 'full_name',
      },
    }
    render(<PersonaPanel persona={persona} />)
    expect(screen.getByTestId('onboarding-badge')).toHaveTextContent('0/7')
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
        location_pref: '{"remote":true,"cities":["NYC"]}',
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
          { field: 'location_pref', filled: true },
          { field: 'master_resume', filled: true },
          { field: 'bio', filled: true },
          { field: 'why_this_exists', filled: true },
        ],
        filledCount: 7,
        totalCount: 7,
        complete: true,
        nextField: null,
      },
    }
    render(<PersonaPanel persona={persona} />)
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Backend Engineer, Platform Engineer')).toBeInTheDocument()
    expect(screen.getByText('$180,000')).toBeInTheDocument()
    expect(screen.getByTestId('onboarding-badge')).toHaveTextContent('7/7')
  })
})

describe('PauseSpendControl', () => {
  it('shows "spend live" + pauses on click (optimistically flips to frozen)', async () => {
    const onControl = vi.fn(ok)
    render(<PauseSpendControl pauseState="active" onControl={onControl} />)
    expect(screen.getByTestId('pause-spend-badge')).toHaveTextContent('spend live')
    fireEvent.click(screen.getByTestId('pause-spend-pause'))
    await waitFor(() => expect(onControl).toHaveBeenCalledWith('pause'))
    await waitFor(() => expect(screen.getByTestId('pause-spend-badge')).toHaveTextContent('spend frozen'))
    expect(screen.getByTestId('pause-spend-resume')).toBeInTheDocument()
  })

  it('shows "spend frozen" + resumes on click', async () => {
    const onControl = vi.fn(ok)
    render(<PauseSpendControl pauseState="halted" onControl={onControl} />)
    expect(screen.getByTestId('pause-spend-badge')).toHaveTextContent('spend frozen')
    fireEvent.click(screen.getByTestId('pause-spend-resume'))
    await waitFor(() => expect(onControl).toHaveBeenCalledWith('resume'))
  })

  it('reverts the optimistic flip + shows the error when the control call fails', async () => {
    const onControl = vi.fn(async () => ({ ok: false as const, status: 500, error: 'boom' }))
    render(<PauseSpendControl pauseState="active" onControl={onControl} />)
    fireEvent.click(screen.getByTestId('pause-spend-pause'))
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
    expect(screen.getByTestId('pause-spend-badge')).toHaveTextContent('spend live') // reverted
  })

  it('shows a read-only note under killswitch — no pause/resume button on the page', () => {
    render(<PauseSpendControl pauseState="killswitch" onControl={vi.fn(ok)} />)
    expect(screen.getByText(/recover via SSH/i)).toBeInTheDocument()
    expect(screen.queryByTestId('pause-spend-resume')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pause-spend-pause')).not.toBeInTheDocument()
  })
})

describe('ResetControl (§24.48)', () => {
  const okReset = async () => ({ ok: true as const, status: 200, cleared: {}, halted: false })

  function personaWith(filled: Record<string, boolean>): DevPersonaResponse {
    const order = [
      'full_name',
      'target_roles',
      'comp_floor',
      'location_pref',
      'master_resume',
      'bio',
      'why_this_exists',
    ]
    return {
      profile: null,
      candidateMd: '# Jane Doe',
      onboarding: {
        fields: order.map((field) => ({ field, filled: filled[field] ?? false })),
        filledCount: Object.values(filled).filter(Boolean).length,
        totalCount: order.length,
        complete: false,
        nextField: null,
      },
    }
  }

  it('renders the four scope buttons + per-field buttons; empty fields are disabled', () => {
    render(<ResetControl persona={personaWith({ full_name: true, master_resume: true })} onReset={vi.fn(okReset)} />)
    for (const scope of ['funnel-data', 'conversation', 'profile', 'everything']) {
      expect(screen.getByTestId(`reset-scope-${scope}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('reset-field-master_resume')).toBeEnabled()
    expect(screen.getByTestId('reset-field-bio')).toBeDisabled() // not filled → nothing to clear
  })

  it('gates a scope reset behind a typed confirm, then calls onReset with the scope', async () => {
    const onReset = vi.fn(okReset)
    render(<ResetControl persona={personaWith({})} onReset={onReset} />)

    fireEvent.click(screen.getByTestId('reset-scope-funnel-data'))
    const go = screen.getByTestId('reset-confirm-go')
    expect(go).toBeDisabled() // no confirm typed yet

    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'funnel-data' } })
    expect(go).toBeEnabled()
    fireEvent.click(go)
    await waitFor(() => expect(onReset).toHaveBeenCalledWith({ scope: 'funnel-data' }))
  })

  it('per-field reset calls onReset with { field } and shows the result', async () => {
    const onReset = vi.fn(okReset)
    render(<ResetControl persona={personaWith({ master_resume: true })} onReset={onReset} />)

    fireEvent.click(screen.getByTestId('reset-field-master_resume'))
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'master_resume' } })
    fireEvent.click(screen.getByTestId('reset-confirm-go'))
    await waitFor(() => expect(onReset).toHaveBeenCalledWith({ field: 'master_resume' }))
    await waitFor(() => expect(screen.getByTestId('reset-status')).toHaveTextContent(/reset master resume/i))
  })

  it('surfaces the halted note when a session-clearing scope returns halted', async () => {
    const onReset = vi.fn(async () => ({ ok: true as const, status: 200, halted: true }))
    render(<ResetControl persona={personaWith({})} onReset={onReset} />)

    fireEvent.click(screen.getByTestId('reset-scope-everything'))
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'everything' } })
    fireEvent.click(screen.getByTestId('reset-confirm-go'))
    await waitFor(() => expect(screen.getByTestId('reset-status')).toHaveTextContent(/halted/i))
  })

  it('cancel dismisses the confirm without calling onReset', () => {
    const onReset = vi.fn(okReset)
    render(<ResetControl persona={personaWith({})} onReset={onReset} />)
    fireEvent.click(screen.getByTestId('reset-scope-profile'))
    expect(screen.getByTestId('reset-confirm')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reset-confirm-cancel'))
    expect(screen.queryByTestId('reset-confirm')).not.toBeInTheDocument()
    expect(onReset).not.toHaveBeenCalled()
  })
})
