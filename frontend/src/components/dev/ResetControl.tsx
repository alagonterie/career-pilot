import * as React from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { cn } from '~/lib/utils'
import {
  fieldLabel,
  RESET_SCOPES,
  type DevPersonaResponse,
  type DevResetBody,
  type DevResetResult,
  type ResetScopeMeta,
} from '~/lib/use-dev-inspector'

interface ResetControlProps {
  persona: DevPersonaResponse | null
  onReset: (body: DevResetBody) => Promise<DevResetResult>
}

/** What's currently armed for confirmation: a grouped scope or a single field. */
type Armed =
  | { kind: 'scope'; meta: ResetScopeMeta; confirm: string }
  | { kind: 'field'; field: string; confirm: string }

/**
 * The dev "Reset" block (§24.48). Scoped + per-onboarding-field resets behind a
 * typed-confirm gate (no native confirm dialog). Session-clearing scopes
 * (conversation / everything) halt the agent first — the result line points the
 * owner back to Resume. Dev-only + owner-only; the endpoint 404s off the dev stack.
 */
export function ResetControl({ persona, onReset }: ResetControlProps) {
  const [armed, setArmed] = React.useState<Armed | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const target = armed ? (armed.kind === 'scope' ? armed.meta.scope : armed.field) : undefined
  const halts = armed?.kind === 'scope' ? armed.meta.halts : false
  const confirmed = armed != null && armed.confirm.trim() === target

  const cancel = React.useCallback(() => setArmed(null), [])

  const run = React.useCallback(async () => {
    if (!armed || armed.confirm.trim() !== (armed.kind === 'scope' ? armed.meta.scope : armed.field)) return
    const body: DevResetBody = armed.kind === 'scope' ? { scope: armed.meta.scope } : { field: armed.field }
    const what = armed.kind === 'scope' ? armed.meta.label : fieldLabel(armed.field)
    setBusy(true)
    setMsg(null)
    const res = await onReset(body)
    setBusy(false)
    setArmed(null)
    if (!res.ok) {
      setMsg({ tone: 'error', text: res.error ?? `HTTP ${res.status}` })
      return
    }
    const tail = res.halted ? ' Agent halted — Resume above to bring it back.' : ''
    setMsg({ tone: 'ok', text: `Reset ${what}.${tail}` })
  }, [armed, onReset])

  const fields = persona?.onboarding.fields ?? []

  return (
    <Card data-testid="reset-control" className="border-destructive/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reset</CardTitle>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Wipe app data back to a chosen starting point, then drive the loop again. Dev-only and reversible-on-reseed —
          credentials, pairing, and infra are never touched here. Each action needs a typed confirm.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-0">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {RESET_SCOPES.map((m) => (
            <button
              key={m.scope}
              type="button"
              data-testid={`reset-scope-${m.scope}`}
              disabled={busy}
              onClick={() => {
                setMsg(null)
                setArmed({ kind: 'scope', meta: m, confirm: '' })
              }}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50',
                m.scope === 'everything'
                  ? 'border-destructive/50 hover:bg-destructive/10'
                  : 'border-border hover:bg-muted',
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                {m.label}
                {m.halts ? (
                  <span className="rounded-sm bg-warn/15 px-1 font-mono text-[9px] uppercase tracking-wide text-warn">
                    halts
                  </span>
                ) : null}
              </span>
              <span className="text-[10px] leading-snug text-muted-foreground">{m.clears}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Reset one onboarding field
          </span>
          {fields.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">Persona not loaded.</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {fields.map((f) => (
                <button
                  key={f.field}
                  type="button"
                  data-testid={`reset-field-${f.field}`}
                  disabled={busy || !f.filled}
                  title={f.filled ? `Clear ${fieldLabel(f.field)}` : `${fieldLabel(f.field)} is already empty`}
                  onClick={() => {
                    setMsg(null)
                    setArmed({ kind: 'field', field: f.field, confirm: '' })
                  }}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-40',
                    f.filled ? 'border-border hover:bg-muted' : 'border-border/50',
                  )}
                >
                  {fieldLabel(f.field)}
                  {!f.filled ? <span className="ml-1 text-[9px] text-muted-foreground">empty</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>

        {armed ? (
          <div
            data-testid="reset-confirm"
            className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5"
          >
            <span className="text-[11px] leading-snug">
              {armed.kind === 'scope' ? (
                <>
                  This clears <strong>{armed.meta.label.toLowerCase()}</strong>: {armed.meta.clears}
                </>
              ) : (
                <>
                  This clears the <strong>{fieldLabel(armed.field)}</strong> field on your profile.
                </>
              )}
              {halts ? ' The agent will be halted.' : ''}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                Type <code className="font-mono text-foreground">{target}</code> to confirm:
              </span>
              <input
                data-testid="reset-confirm-input"
                autoFocus
                value={armed.confirm}
                disabled={busy}
                onChange={(e) => setArmed((a) => (a ? { ...a, confirm: e.target.value } : a))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && confirmed) void run()
                  if (e.key === 'Escape') cancel()
                }}
                className="w-40 rounded border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                data-testid="reset-confirm-go"
                disabled={!confirmed || busy}
                onClick={() => void run()}
                className="rounded-md border border-transparent bg-destructive px-3 py-1 text-[11px] font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-40"
              >
                Reset
              </button>
              <button
                type="button"
                data-testid="reset-confirm-cancel"
                disabled={busy}
                onClick={cancel}
                className="rounded-md border border-border px-3 py-1 text-[11px] font-semibold transition-colors hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {msg ? (
          <p
            data-testid="reset-status"
            className={cn('text-[11px]', msg.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive')}
          >
            {msg.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
