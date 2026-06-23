import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DevKnob } from '~/lib/use-dev-inspector'

import { ModelControls } from './ModelControls'

const ok = async () => ({ ok: true as const, status: 200 })

const MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8']

function modelKnob(key: string, value: string, options = MODELS): DevKnob {
  return {
    key,
    type: 'enum',
    group: 'models',
    value,
    default: value,
    overridden: false,
    label: key,
    min: null,
    max: null,
    integer: false,
    options,
    maxLength: null,
    note: null,
  }
}

// A representative slice of the §24.163 models feed: an owner orchestrator + subagent,
// a sandbox orchestrator, and a host-side call.
const KNOBS: DevKnob[] = [
  modelKnob('owner_orchestrator_model', 'claude-sonnet-4-6'),
  modelKnob('owner_model_research_company', 'claude-haiku-4-5', [...MODELS, 'inherit']),
  modelKnob('sandbox_orchestrator_model', 'claude-sonnet-4-6'),
  modelKnob('lead_ranking_model', 'claude-haiku-4-5'),
]

describe('ModelControls', () => {
  it('splits the models feed into Owner / Sandbox / Host sections by key-prefix', () => {
    render(<ModelControls knobs={KNOBS} onWrite={ok} onReset={ok} />)
    expect(screen.getByTestId('model-section-owner')).toBeInTheDocument()
    expect(screen.getByTestId('model-section-sandbox')).toBeInTheDocument()
    expect(screen.getByTestId('model-section-host')).toBeInTheDocument()

    // Owner knobs land in the owner section; the host-side call lands in host.
    expect(
      within(screen.getByTestId('model-section-owner')).getByTestId('knob-owner_orchestrator_model'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('model-section-owner')).getByTestId('knob-owner_model_research_company'),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('model-section-host')).getByTestId('knob-lead_ranking_model')).toBeInTheDocument()
  })

  it('omits a section with no knobs', () => {
    render(<ModelControls knobs={[modelKnob('lead_ranking_model', 'claude-haiku-4-5')]} onWrite={ok} onReset={ok} />)
    expect(screen.queryByTestId('model-section-owner')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-section-sandbox')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-section-host')).toBeInTheDocument()
  })

  it('writes the picked model through the shared knob row', async () => {
    const onWrite = vi.fn(ok)
    render(<ModelControls knobs={KNOBS} onWrite={onWrite} onReset={ok} />)
    const row = screen.getByTestId('knob-owner_orchestrator_model')
    fireEvent.click(within(row).getByTestId('knob-option-owner_orchestrator_model-claude-opus-4-8'))
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith('owner_orchestrator_model', 'claude-opus-4-8'))
  })
})
