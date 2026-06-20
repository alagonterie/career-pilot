import * as React from 'react'

import { cn } from '~/lib/utils'
import type { AdminSummary, AdminWriteResult } from '~/lib/use-admin'

type ControlBody =
  | { action: 'pause' | 'resume' }
  | { action: 'killswitch'; confirm: true }
  | { action: 'set_live_mode'; on: boolean; confirm?: true }

interface Props {
  mode: AdminSummary['mode'] | undefined
  onControl: (body: ControlBody) => Promise<AdminWriteResult>
}

/**
 * The §24.138 Overview mode controls. Reversible actions (pause/resume, live →
 * shadow) fire on a single click; the destructive ones (go LIVE, kill-switch) use
 * a two-step inline confirm — no modal dependency, fully testable. A 409 on
 * go-LIVE surfaces the missing `_required_before_live_mode` profile fields.
 */
export function AdminModeControls({ mode, onControl }: Props) {
  const [confirming, setConfirming] = React.useState<'live' | 'killswitch' | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [missing, setMissing] = React.useState<string[] | null>(null)

  const live = mode?.live_mode === true
  const pause = mode?.pause_state ?? 'active'
  const killed = pause === 'killswitch'

  const run = async (body: ControlBody) => {
    setBusy(true)
    setError(null)
    setMissing(null)
    const res = await onControl(body)
    setBusy(false)
    setConfirming(null)
    if (!res.ok) {
      setError(res.error ?? `HTTP ${res.status}`)
      if (res.missing) setMissing(res.missing)
    }
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      data-testid="admin-mode-controls"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <ModeBadge
          label="Mode"
          value={live ? 'LIVE' : 'SHADOW'}
          tone={live ? 'live' : 'muted'}
          testid="admin-live-badge"
        />
        <ModeBadge
          label="Run state"
          value={killed ? 'KILLED' : pause === 'halted' ? 'HALTED' : pause === 'paused' ? 'PAUSED' : 'RUNNING'}
          tone={killed || pause === 'halted' ? 'alert' : pause === 'paused' ? 'warn' : 'ok'}
          testid="admin-run-badge"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Live mode */}
        {live ? (
          <ControlButton
            testid="admin-shadow-btn"
            disabled={busy}
            onClick={() => void run({ action: 'set_live_mode', on: false })}
          >
            ↩ Back to SHADOW
          </ControlButton>
        ) : confirming === 'live' ? (
          <ConfirmPair
            label="Go LIVE — real outreach will send. Confirm?"
            onConfirm={() => void run({ action: 'set_live_mode', on: true, confirm: true })}
            onCancel={() => setConfirming(null)}
            busy={busy}
            tone="live"
          />
        ) : (
          <ControlButton testid="admin-live-btn" tone="live" disabled={busy} onClick={() => setConfirming('live')}>
            ◆ Go LIVE
          </ControlButton>
        )}

        {/* Pause / resume */}
        {!killed &&
          (pause === 'active' ? (
            <ControlButton testid="admin-pause-btn" disabled={busy} onClick={() => void run({ action: 'pause' })}>
              ⏸ Pause spend
            </ControlButton>
          ) : (
            <ControlButton testid="admin-resume-btn" disabled={busy} onClick={() => void run({ action: 'resume' })}>
              ▶ Resume
            </ControlButton>
          ))}

        {/* Kill switch (destructive, confirm-gated) */}
        {killed ? (
          <span className="font-mono text-[11px] text-destructive">
            killswitch engaged — recovery is manual (RECOVERY.md)
          </span>
        ) : confirming === 'killswitch' ? (
          <ConfirmPair
            label="Kill switch — halts everything; recovery is manual. Confirm?"
            onConfirm={() => void run({ action: 'killswitch', confirm: true })}
            onCancel={() => setConfirming(null)}
            busy={busy}
            tone="alert"
          />
        ) : (
          <ControlButton
            testid="admin-killswitch-btn"
            tone="alert"
            disabled={busy}
            onClick={() => setConfirming('killswitch')}
          >
            ⛔ Kill switch
          </ControlButton>
        )}
      </div>

      {error ? (
        <p className="text-[11px] text-destructive" data-testid="admin-control-error">
          {error}
          {missing && missing.length > 0 ? <span> — missing profile fields: {missing.join(', ')}</span> : null}
        </p>
      ) : null}
    </div>
  )
}

function ModeBadge({
  label,
  value,
  tone,
  testid,
}: {
  label: string
  value: string
  tone: 'live' | 'ok' | 'warn' | 'alert' | 'muted'
  testid: string
}) {
  const dot =
    tone === 'live'
      ? 'bg-ai'
      : tone === 'ok'
        ? 'bg-primary'
        : tone === 'warn'
          ? 'bg-amber-400'
          : tone === 'alert'
            ? 'bg-destructive'
            : 'bg-muted-foreground'
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span
        className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums text-foreground"
        data-testid={testid}
      >
        <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', dot)} />
        {value}
      </span>
    </div>
  )
}

function ControlButton({
  children,
  onClick,
  disabled,
  tone,
  testid,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'live' | 'alert'
  testid: string
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-md border px-3 py-1.5 font-mono text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'live'
          ? 'border-ai/50 text-ai hover:bg-ai/10'
          : tone === 'alert'
            ? 'border-destructive/50 text-destructive hover:bg-destructive/10'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function ConfirmPair({
  label,
  onConfirm,
  onCancel,
  busy,
  tone,
}: {
  label: string
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
  tone: 'live' | 'alert'
}) {
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="admin-confirm">
      <span className="font-mono text-[11px] text-foreground">{label}</span>
      <button
        type="button"
        data-testid="admin-confirm-yes"
        onClick={onConfirm}
        disabled={busy}
        className={cn(
          'rounded-md px-2.5 py-1 font-mono text-xs font-semibold text-white transition-colors disabled:opacity-40',
          tone === 'live' ? 'bg-ai hover:bg-ai/90' : 'bg-destructive hover:bg-destructive/90',
        )}
      >
        Confirm
      </button>
      <button
        type="button"
        data-testid="admin-confirm-no"
        onClick={onCancel}
        disabled={busy}
        className="rounded-md border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Cancel
      </button>
    </span>
  )
}
