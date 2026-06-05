import * as React from 'react'

import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'
import type { DevKnob, KnobWriteResult } from '~/lib/use-dev-inspector'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface KnobControlProps {
  knob: DevKnob
  onWrite: (key: string, value: boolean | number | string) => Promise<KnobWriteResult>
}

/**
 * One writable knob (24.42c). Controlled by local state seeded from the polled
 * value so edits feel instant; the parent poll reconciles the source of truth.
 * Commits on toggle (boolean), blur/Enter (number, cron), or slider release. A
 * rejected write (server re-validates) reverts the control and shows the reason.
 */
export function KnobControl({ knob, onWrite }: KnobControlProps) {
  const [value, setValue] = React.useState<boolean | number | string>(coerce(knob))
  const [save, setSave] = React.useState<SaveState>('idle')
  const [error, setError] = React.useState<string | null>(null)
  // Re-seed from the poll only while the control is idle (don't clobber an edit
  // in flight or a value the user is actively changing).
  const baseline = coerce(knob)
  React.useEffect(() => {
    if (save === 'idle') setValue(baseline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [String(baseline)])

  const commit = React.useCallback(
    async (next: boolean | number | string) => {
      setSave('saving')
      setError(null)
      const res = await onWrite(knob.key, next)
      if (res.ok) {
        setSave('saved')
        setTimeout(() => setSave('idle'), 1500)
      } else {
        setValue(baseline) // revert
        setError(res.error ?? `HTTP ${res.status}`)
        setSave('error')
      }
    },
    [knob.key, onWrite, baseline],
  )

  return (
    <div className="flex flex-col gap-1 py-2" data-testid={`knob-${knob.key}`}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`knob-input-${knob.key}`} className="text-sm font-medium text-foreground">
          {knob.label}
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">{knob.key}</span>
        </label>
        <SaveIndicator state={save} />
      </div>

      {knob.type === 'boolean' ? (
        <BooleanToggle id={knob.key} value={value === true} onToggle={(v) => void commit(v)} />
      ) : knob.type === 'number' ? (
        <NumberInput id={knob.key} knob={knob} value={value} setValue={setValue} commit={commit} />
      ) : (
        <CronInput id={knob.key} value={String(value)} setValue={setValue} commit={commit} />
      )}

      {knob.note ? <p className="text-[11px] leading-snug text-muted-foreground">{knob.note}</p> : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}

function coerce(knob: DevKnob): boolean | number | string {
  if (knob.type === 'boolean') return knob.value === true
  if (knob.type === 'number') return typeof knob.value === 'number' ? knob.value : Number(knob.value)
  return String(knob.value ?? '')
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'idle') return null
  const map = {
    saving: { text: 'saving…', cls: 'text-muted-foreground' },
    saved: { text: 'saved ✓', cls: 'text-accent-cool' },
    error: { text: 'failed ✕', cls: 'text-destructive' },
  } as const
  const m = map[state]
  return <span className={cn('font-mono text-[10px]', m.cls)}>{m.text}</span>
}

function BooleanToggle({ id, value, onToggle }: { id: string; value: boolean; onToggle: (v: boolean) => void }) {
  return (
    <button
      id={`knob-input-${id}`}
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onToggle(!value)}
      className={cn(
        'inline-flex w-fit items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold transition-colors',
        value
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border bg-muted text-muted-foreground hover:bg-muted/70',
      )}
    >
      <span
        className={cn('inline-block h-2 w-2 rounded-full', value ? 'bg-primary-foreground' : 'bg-muted-foreground')}
      />
      {value ? 'ON' : 'OFF'}
    </button>
  )
}

interface NumberInputProps {
  id: string
  knob: DevKnob
  value: boolean | number | string
  setValue: (v: number) => void
  commit: (v: number) => Promise<void>
}

function NumberInput({ id, knob, value, setValue, commit }: NumberInputProps) {
  const num = typeof value === 'number' ? value : Number(value)
  const hasRange = knob.min != null && knob.max != null
  const step = knob.integer ? 1 : knob.max != null && knob.max <= 1 ? 0.05 : 1

  const tryCommit = (raw: number) => {
    if (!Number.isFinite(raw)) return
    if (knob.min != null && raw < knob.min) return
    if (knob.max != null && raw > knob.max) return
    if (knob.integer && !Number.isInteger(raw)) return
    void commit(raw)
  }

  return (
    <div className="flex items-center gap-3">
      {hasRange ? (
        <input
          type="range"
          aria-label={`${knob.label} slider`}
          min={knob.min ?? undefined}
          max={knob.max ?? undefined}
          step={step}
          value={Number.isFinite(num) ? num : 0}
          onChange={(e) => setValue(Number(e.target.value))}
          onMouseUp={(e) => tryCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => tryCommit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => tryCommit(Number((e.target as HTMLInputElement).value))}
          className="h-1 flex-1 cursor-pointer accent-primary"
        />
      ) : null}
      <input
        id={`knob-input-${id}`}
        type="number"
        inputMode="decimal"
        min={knob.min ?? undefined}
        max={knob.max ?? undefined}
        step={step}
        value={Number.isFinite(num) ? String(num) : ''}
        onChange={(e) => setValue(Number(e.target.value))}
        onBlur={(e) => tryCommit(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') tryCommit(Number((e.target as HTMLInputElement).value))
        }}
        className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm tabular-nums"
      />
      {knob.min != null && knob.max != null ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {knob.min}–{knob.max}
        </span>
      ) : null}
    </div>
  )
}

function CronInput({
  id,
  value,
  setValue,
  commit,
}: {
  id: string
  value: string
  setValue: (v: string) => void
  commit: (v: string) => Promise<void>
}) {
  return (
    <input
      id={`knob-input-${id}`}
      type="text"
      spellCheck={false}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit((e.target as HTMLInputElement).value)
      }}
      className="w-44 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
      placeholder="* * * * *"
    />
  )
}
