import * as React from 'react'

import { cn } from '~/lib/utils'
import type { DevKnob, KnobWriteResult } from '~/lib/use-dev-inspector'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface KnobControlProps {
  knob: DevKnob
  onWrite: (key: string, value: boolean | number | string) => Promise<KnobWriteResult>
  onReset: (key: string) => Promise<KnobWriteResult>
}

/**
 * One writable knob (24.42c). Controlled by local state seeded from the polled
 * value, updated OPTIMISTICALLY on every commit so the control reflects the
 * change instantly (the parent poll reconciles the source of truth); reverts +
 * shows the reason if the server rejects. Commits on toggle (boolean), blur/Enter
 * (number, cron), or slider release. A per-knob reset (shown when the knob is
 * overridden) clears the preferences override → back to the default.
 */
export function KnobControl({ knob, onWrite, onReset }: KnobControlProps) {
  const [value, setValue] = React.useState<boolean | number | string>(coerceVal(knob.type, knob.value))
  const [save, setSave] = React.useState<SaveState>('idle')
  const [error, setError] = React.useState<string | null>(null)

  // Re-seed from the poll only while idle — don't clobber an edit in flight.
  const baseline = coerceVal(knob.type, knob.value)
  React.useEffect(() => {
    if (save === 'idle') setValue(baseline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [String(baseline)])

  const commit = React.useCallback(
    async (next: boolean | number | string) => {
      setValue(next) // optimistic — the control reflects the change immediately
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

  const doReset = React.useCallback(async () => {
    setSave('saving')
    setError(null)
    const res = await onReset(knob.key)
    if (res.ok) {
      setValue(coerceVal(knob.type, knob.default))
      setSave('saved')
      setTimeout(() => setSave('idle'), 1500)
    } else {
      setError(res.error ?? `HTTP ${res.status}`)
      setSave('error')
    }
  }, [knob.key, knob.type, knob.default, onReset])

  return (
    <div className="flex flex-col gap-1 py-2" data-testid={`knob-${knob.key}`}>
      <div className="flex items-start justify-between gap-2">
        {/* min-w-0 + truncate so the long unbreakable config key can shrink on
            narrow screens (iPhone SE) instead of forcing horizontal overflow. */}
        <label htmlFor={`knob-input-${knob.key}`} className="min-w-0 flex-1 text-sm font-medium text-foreground">
          <span className="block truncate">{knob.label}</span>
          <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground" title={knob.key}>
            {knob.key}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-2">
          {knob.overridden ? (
            <button
              type="button"
              onClick={() => void doReset()}
              data-testid={`knob-reset-${knob.key}`}
              title="Reset to default"
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ↺ reset
            </button>
          ) : null}
          <SaveIndicator state={save} />
        </div>
      </div>

      {knob.type === 'boolean' ? (
        <BooleanToggle id={knob.key} value={value === true} onToggle={(v) => void commit(v)} />
      ) : knob.type === 'number' ? (
        <NumberInput id={knob.key} knob={knob} value={value} setValue={setValue} commit={commit} />
      ) : knob.type === 'enum' ? (
        <EnumSelect id={knob.key} options={knob.options ?? []} value={String(value)} onSelect={(v) => void commit(v)} />
      ) : knob.type === 'cron' ? (
        <CronInput id={knob.key} value={String(value)} setValue={setValue} commit={commit} />
      ) : (
        <TextInput id={knob.key} knob={knob} value={String(value)} setValue={setValue} commit={commit} />
      )}

      {knob.note ? <p className="text-[11px] leading-snug text-muted-foreground">{knob.note}</p> : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}

function coerceVal(type: DevKnob['type'], raw: unknown): boolean | number | string {
  if (type === 'boolean') return raw === true
  if (type === 'number') return typeof raw === 'number' ? raw : Number(raw)
  return String(raw ?? '')
}

// A fixed-width slot so the transient "saving…/saved" text never reflows the row
// (it fades in/out within a reserved box instead of changing the layout).
function SaveIndicator({ state }: { state: SaveState }) {
  const map: Record<SaveState, { text: string; cls: string }> = {
    idle: { text: '', cls: '' },
    saving: { text: 'saving…', cls: 'text-muted-foreground' },
    saved: { text: 'saved ✓', cls: 'text-accent-cool' },
    error: { text: 'failed ✕', cls: 'text-destructive' },
  }
  const m = map[state]
  return (
    <span
      aria-hidden={state === 'idle'}
      data-testid="knob-save-indicator"
      className={cn('inline-block w-16 shrink-0 text-right font-mono text-[10px] tabular-nums', m.cls)}
    >
      {m.text}
    </span>
  )
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

/**
 * A segmented control for an `enum` knob (e.g. the dev model tier). Commits the
 * picked option immediately, like the boolean toggle. `radiogroup` semantics so
 * it's keyboard/AT-navigable. Wraps on narrow screens.
 */
function EnumSelect({
  id,
  options,
  value,
  onSelect,
}: {
  id: string
  options: string[]
  value: string
  onSelect: (v: string) => void
}) {
  return (
    <div
      id={`knob-input-${id}`}
      role="radiogroup"
      aria-label={`${id} options`}
      className="inline-flex w-fit flex-wrap gap-1 rounded-md border border-border bg-muted/40 p-0.5"
    >
      {options.map((opt) => {
        const active = opt === value
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`knob-option-${id}-${opt}`}
            onClick={() => onSelect(opt)}
            className={cn(
              'rounded px-2.5 py-1 font-mono text-xs font-semibold transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {opt}
          </button>
        )
      })}
    </div>
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
          className="h-1 min-w-0 flex-1 basis-24 cursor-pointer accent-primary"
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

/** A free-text knob (quiet hours, Drive folder ids/names). Commits on blur/Enter;
 *  the server re-validates the maxLength + any pattern. */
function TextInput({
  id,
  knob,
  value,
  setValue,
  commit,
}: {
  id: string
  knob: DevKnob
  value: string
  setValue: (v: string) => void
  commit: (v: string) => Promise<void>
}) {
  return (
    <input
      id={`knob-input-${id}`}
      type="text"
      spellCheck={false}
      maxLength={knob.maxLength ?? undefined}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit((e.target as HTMLInputElement).value)
      }}
      className="w-full max-w-xs rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
    />
  )
}
