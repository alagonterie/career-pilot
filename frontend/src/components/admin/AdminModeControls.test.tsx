import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AdminSummary, AdminWriteResult } from '~/lib/use-admin'

import { AdminModeControls } from './AdminModeControls'

const okWrite = async (): Promise<AdminWriteResult> => ({ ok: true, status: 200 })

function mode(over: Partial<AdminSummary['mode']> = {}): AdminSummary['mode'] {
  return { live_mode: false, pause_state: 'active', pause_reason: null, backend: 'online', ...over }
}

describe('AdminModeControls', () => {
  it('renders the mode + run-state badges', () => {
    render(<AdminModeControls mode={mode({ live_mode: true, pause_state: 'halted' })} onControl={okWrite} />)
    expect(screen.getByTestId('admin-live-badge')).toHaveTextContent('LIVE')
    expect(screen.getByTestId('admin-run-badge')).toHaveTextContent('HALTED')
  })

  it('pause fires immediately (reversible, no confirm)', () => {
    const onControl = vi.fn(okWrite)
    render(<AdminModeControls mode={mode()} onControl={onControl} />)
    fireEvent.click(screen.getByTestId('admin-pause-btn'))
    expect(onControl).toHaveBeenCalledWith({ action: 'pause' })
  })

  it('Go LIVE requires a two-step confirm', () => {
    const onControl = vi.fn(okWrite)
    render(<AdminModeControls mode={mode()} onControl={onControl} />)
    fireEvent.click(screen.getByTestId('admin-live-btn'))
    expect(onControl).not.toHaveBeenCalled() // not until confirmed
    expect(screen.getByTestId('admin-confirm')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('admin-confirm-yes'))
    expect(onControl).toHaveBeenCalledWith({ action: 'set_live_mode', on: true, confirm: true })
  })

  it('cancel aborts the confirm without calling onControl', () => {
    const onControl = vi.fn(okWrite)
    render(<AdminModeControls mode={mode()} onControl={onControl} />)
    fireEvent.click(screen.getByTestId('admin-live-btn'))
    fireEvent.click(screen.getByTestId('admin-confirm-no'))
    expect(onControl).not.toHaveBeenCalled()
    expect(screen.queryByTestId('admin-confirm')).not.toBeInTheDocument()
  })

  it('turning live mode OFF needs no confirm', () => {
    const onControl = vi.fn(okWrite)
    render(<AdminModeControls mode={mode({ live_mode: true })} onControl={onControl} />)
    fireEvent.click(screen.getByTestId('admin-shadow-btn'))
    expect(onControl).toHaveBeenCalledWith({ action: 'set_live_mode', on: false })
  })

  it('the kill switch is confirm-gated', () => {
    const onControl = vi.fn(okWrite)
    render(<AdminModeControls mode={mode()} onControl={onControl} />)
    fireEvent.click(screen.getByTestId('admin-killswitch-btn'))
    expect(onControl).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('admin-confirm-yes'))
    expect(onControl).toHaveBeenCalledWith({ action: 'killswitch', confirm: true })
  })

  it('surfaces a 409 with the missing profile fields on Go LIVE', async () => {
    const onControl = vi.fn(
      async (): Promise<AdminWriteResult> => ({
        ok: false,
        status: 409,
        error: 'profile incomplete for live mode',
        missing: ['master_resume', 'bio'],
      }),
    )
    render(<AdminModeControls mode={mode()} onControl={onControl} />)
    fireEvent.click(screen.getByTestId('admin-live-btn'))
    fireEvent.click(screen.getByTestId('admin-confirm-yes'))
    expect(await screen.findByTestId('admin-control-error')).toHaveTextContent('master_resume, bio')
  })

  it('hides resume + offers manual-recovery copy when the killswitch is engaged', () => {
    render(<AdminModeControls mode={mode({ pause_state: 'killswitch' })} onControl={okWrite} />)
    expect(screen.getByTestId('admin-run-badge')).toHaveTextContent('KILLED')
    expect(screen.queryByTestId('admin-resume-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-killswitch-btn')).not.toBeInTheDocument()
  })
})
