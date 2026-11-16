import { useState } from 'react'

import type { DevKnob } from '~/lib/use-dev-inspector'
import {
  postAdminKnob,
  postSweepPreview,
  resetAdminKnob,
  type SweepFilterPreview,
  type SweepFilterProposal,
  type SweepPreviewLead,
} from '~/lib/use-admin'
import { cn } from '~/lib/utils'

/**
 * §24.202 D6 — the sweep-filter editor. Edits the direct-board sweep's filter
 * knobs (titles to keep / drop, locations to keep, max posting age, max new
 * leads per run) in the preferences tier through the ordinary knob write, and
 * previews how many of the open board leads the proposed filters would keep.
 *
 * Save writes nothing when any value is refused: numbers are range-checked
 * here against the knob's own bounds, and the patterns are checked by the
 * host's preview (the same validator the knob write runs) before the first
 * write. The writes then go one key at a time in a fixed order and stop at the
 * first refusal.
 */

/** The editor's knobs, in save order. */
export const SWEEP_FILTER_KEYS = [
  'ats_sweep_title_include',
  'ats_sweep_title_exclude',
  'ats_sweep_location_filter',
  'ats_sweep_max_age_days',
  'ats_sweep_max_new_per_run',
] as const
export type SweepFilterKey = (typeof SWEEP_FILTER_KEYS)[number]

/** The keys a preview can evaluate (the per-run cap is not previewed). */
const PREVIEW_KEYS: readonly SweepFilterKey[] = [
  'ats_sweep_title_include',
  'ats_sweep_title_exclude',
  'ats_sweep_location_filter',
  'ats_sweep_max_age_days',
]

const PATTERN_KEYS: readonly SweepFilterKey[] = [
  'ats_sweep_title_include',
  'ats_sweep_title_exclude',
  'ats_sweep_location_filter',
]

const FIELD_HINT: Record<SweepFilterKey, string> = {
  ats_sweep_title_include: 'A posting whose title does not match is dropped. Empty keeps every title.',
  ats_sweep_title_exclude: 'A posting whose title matches is dropped. Empty drops none.',
  ats_sweep_location_filter: 'Matched against the location and workplace type. Empty keeps every location.',
  ats_sweep_max_age_days: 'Postings older than this are dropped.',
  ats_sweep_max_new_per_run: 'At most this many new leads per sweep. Not part of the preview.',
}

function storedText(k: DevKnob): string {
  return k.value == null ? '' : String(k.value)
}

/** A draft value → what the knob write sends, or the reason it cannot. Mirrors
 *  the host's wording for number bounds so the message reads the same either way. */
export function parseSweepDraft(
  knob: DevKnob,
  raw: string,
): { ok: true; value: string | number } | { ok: false; message: string } {
  if (knob.type === 'number') {
    const t = raw.trim()
    const n = Number(t)
    if (t === '' || !Number.isFinite(n)) return { ok: false, message: `${knob.key} must be a number` }
    if (knob.integer && !Number.isInteger(n)) return { ok: false, message: `${knob.key} must be an integer` }
    if (knob.min != null && n < knob.min) return { ok: false, message: `${knob.key} must be ≥ ${knob.min}` }
    if (knob.max != null && n > knob.max) return { ok: false, message: `${knob.key} must be ≤ ${knob.max}` }
    return { ok: true, value: n }
  }
  if (knob.maxLength != null && raw.length > knob.maxLength) {
    return { ok: false, message: `${knob.key} must be ≤ ${knob.maxLength} characters` }
  }
  return { ok: true, value: raw }
}

type FieldError = { key: string; message: string }

export function SweepFilterEditor({
  knobs,
  baseUrl,
  onSaved,
}: {
  knobs: DevKnob[]
  baseUrl: string
  onSaved: () => void
}) {
  const byKey = new Map(knobs.map((k) => [k.key, k]))
  const present = SWEEP_FILTER_KEYS.filter((k) => byKey.has(k))

  const [drafts, setDrafts] = useState<Partial<Record<SweepFilterKey, string>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<FieldError | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [preview, setPreview] = useState<SweepFilterPreview | null>(null)

  // A host without these knobs: hide the editor rather than show empty fields.
  if (present.length === 0) return null

  const knobOf = (k: SweepFilterKey) => byKey.get(k) as DevKnob
  const valueOf = (k: SweepFilterKey) => drafts[k] ?? storedText(knobOf(k))
  const dirty = present.filter((k) => valueOf(k) !== storedText(knobOf(k)))

  const setDraft = (k: SweepFilterKey, v: string) => {
    setDrafts((d) => ({ ...d, [k]: v }))
    setNote(null)
    if (fieldError?.key === k) setFieldError(null)
  }

  /** Every dirty value parsed, or the first one that cannot be. */
  const parseDirty = (): { ok: true; values: [SweepFilterKey, string | number][] } | { ok: false; err: FieldError } => {
    const values: [SweepFilterKey, string | number][] = []
    for (const k of dirty) {
      const p = parseSweepDraft(knobOf(k), valueOf(k))
      if (!p.ok) return { ok: false, err: { key: k, message: p.message } }
      values.push([k, p.value])
    }
    return { ok: true, values }
  }

  const proposalOf = (values: [SweepFilterKey, string | number][]): SweepFilterProposal => {
    const p: Record<string, string | number> = {}
    for (const [k, v] of values) if (PREVIEW_KEYS.includes(k)) p[k] = v
    return p as SweepFilterProposal
  }

  const runPreview = async (): Promise<void> => {
    setError(null)
    setNote(null)
    const parsed = parseDirty()
    if (!parsed.ok) {
      setFieldError(parsed.err)
      return
    }
    setFieldError(null)
    setBusy('preview')
    const out = await postSweepPreview(baseUrl, proposalOf(parsed.values))
    setBusy(null)
    if (out.kind === 'ok') setPreview(out.preview)
    else if (out.kind === 'invalid') setFieldError({ key: out.field, message: out.message })
    else if (out.kind === 'unsupported') setError('This server cannot preview filters yet.')
    else setError(out.message)
  }

  const save = async (): Promise<void> => {
    setError(null)
    setNote(null)
    const parsed = parseDirty()
    if (!parsed.ok) {
      setFieldError(parsed.err)
      return
    }
    setFieldError(null)
    setBusy('save')
    // Validate every pattern on the host before the first write, so a pattern
    // that does not compile leaves all five knobs as they were.
    if (parsed.values.some(([k]) => PATTERN_KEYS.includes(k))) {
      const check = await postSweepPreview(baseUrl, proposalOf(parsed.values))
      if (check.kind === 'invalid') {
        setBusy(null)
        setFieldError({ key: check.field, message: check.message })
        return
      }
      if (check.kind === 'ok') setPreview(check.preview)
    }
    const saved: SweepFilterKey[] = []
    for (const [k, v] of parsed.values) {
      const res = await postAdminKnob(baseUrl, k, v)
      if (!res.ok) {
        setBusy(null)
        setFieldError({ key: k, message: res.error ?? `write failed (${res.status})` })
        if (saved.length > 0) {
          setError(`Saved ${saved.join(', ')} before ${k} was refused.`)
          setDrafts((d) => {
            const next = { ...d }
            for (const s of saved) delete next[s]
            return next
          })
          onSaved()
        }
        return
      }
      saved.push(k)
    }
    setBusy(null)
    setDrafts({})
    setNote(`Saved ${saved.length} filter${saved.length === 1 ? '' : 's'}. The next sweep uses them.`)
    onSaved()
  }

  const reset = async (k: SweepFilterKey): Promise<void> => {
    setError(null)
    setNote(null)
    setBusy(`reset-${k}`)
    const res = await resetAdminKnob(baseUrl, k)
    setBusy(null)
    if (!res.ok) {
      setFieldError({ key: k, message: res.error ?? `reset failed (${res.status})` })
      return
    }
    setDrafts((d) => {
      const next = { ...d }
      delete next[k]
      return next
    })
    setNote(`${knobOf(k).label} is back to its default.`)
    onSaved()
  }

  const discard = () => {
    setDrafts({})
    setFieldError(null)
    setError(null)
    setNote(null)
  }

  const canPreview = present.some((k) => PREVIEW_KEYS.includes(k))
  const input =
    'w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <div data-testid="sweep-filters" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Sweep filters</h2>
        <p className="text-[11px] leading-snug text-muted-foreground">
          What the board sweep keeps. Patterns are regular expressions, matched ignoring case. Saved values override the
          defaults until reset.
        </p>
      </div>

      {present.map((k) => {
        const knob = knobOf(k)
        const err = fieldError?.key === k ? fieldError.message : null
        const isText = knob.type !== 'number'
        return (
          <div key={k} className="flex flex-col gap-1" data-testid={`sweep-field-${k}`}>
            <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-foreground">
              <label htmlFor={`sweep-input-${k}`}>{knob.label}</label>
              {knob.overridden ? (
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">custom</span>
              ) : null}
              {drafts[k] != null && drafts[k] !== storedText(knob) ? (
                <span className="rounded bg-accent-cool/15 px-1 text-[10px] text-accent-cool">edited</span>
              ) : null}
              {knob.overridden ? (
                <button
                  type="button"
                  data-testid={`sweep-reset-${k}`}
                  disabled={busy != null}
                  onClick={() => void reset(k)}
                  className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
                >
                  {busy === `reset-${k}` ? 'resetting…' : 'reset to default'}
                </button>
              ) : null}
            </span>
            {isText && k !== 'ats_sweep_location_filter' ? (
              <textarea
                id={`sweep-input-${k}`}
                data-testid={`sweep-input-${k}`}
                value={valueOf(k)}
                rows={2}
                spellCheck={false}
                aria-invalid={err ? true : undefined}
                onChange={(e) => setDraft(k, e.target.value)}
                className={cn(input, 'resize-y', err && 'border-destructive')}
              />
            ) : (
              <input
                type={isText ? 'text' : 'number'}
                id={`sweep-input-${k}`}
                data-testid={`sweep-input-${k}`}
                value={valueOf(k)}
                min={knob.min ?? undefined}
                max={knob.max ?? undefined}
                spellCheck={false}
                aria-invalid={err ? true : undefined}
                onChange={(e) => setDraft(k, e.target.value)}
                className={cn(input, !isText && 'max-w-[8rem]', err && 'border-destructive')}
              />
            )}
            <span className="text-[10px] leading-snug text-muted-foreground">{FIELD_HINT[k]}</span>
            {err ? (
              <span data-testid="sweep-field-error" role="alert" className="font-mono text-[11px] text-destructive">
                {err}
              </span>
            ) : null}
          </div>
        )
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="sweep-save"
          disabled={busy != null || dirty.length === 0}
          onClick={() => void save()}
          className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {busy === 'save'
            ? 'Saving…'
            : dirty.length > 0
              ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}`
              : 'Save'}
        </button>
        {canPreview ? (
          <button
            type="button"
            data-testid="sweep-preview"
            disabled={busy != null}
            onClick={() => void runPreview()}
            className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {busy === 'preview' ? 'Previewing…' : 'Preview'}
          </button>
        ) : null}
        {dirty.length > 0 ? (
          <button
            type="button"
            data-testid="sweep-discard"
            disabled={busy != null}
            onClick={discard}
            className="rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            discard edits
          </button>
        ) : null}
      </div>

      {note ? (
        <p data-testid="sweep-note" className="font-mono text-[11px] text-primary">
          {note}
        </p>
      ) : null}
      {error ? (
        <p data-testid="sweep-error" role="alert" className="font-mono text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {preview ? <PreviewResult preview={preview} /> : null}
    </div>
  )
}

/** "filter 3 · age 1", or '' when nothing was dropped. */
function reasonsLine(by: Partial<Record<string, number>>): string {
  return Object.entries(by)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([r, n]) => `${r} ${n}`)
    .join(' · ')
}

/** The preview's headline, e.g. "Of 120 open board leads: current filters keep 90, these keep 84." */
export function previewHeadline(p: SweepFilterPreview): string {
  return (
    `Of ${p.total} open board lead${p.total === 1 ? '' : 's'}: current filters keep ${p.current.keep}, ` +
    `these keep ${p.proposed.keep} (${p.newly_dropped} newly dropped, ${p.newly_kept} newly kept).`
  )
}

function PreviewResult({ preview }: { preview: SweepFilterPreview }) {
  const reasons = reasonsLine(preview.proposed.drop_by_reason)
  return (
    <div
      data-testid="sweep-preview-result"
      className="flex flex-col gap-1.5 border-t border-border/60 pt-2 font-mono text-[11px] text-muted-foreground"
    >
      <span data-testid="sweep-preview-headline" className="text-foreground">
        {previewHeadline(preview)}
      </span>
      {reasons ? <span>would drop by reason: {reasons}</span> : null}
      <SampleList testId="sweep-preview-dropped" label="Newly dropped" leads={preview.sample_newly_dropped} />
      <SampleList testId="sweep-preview-kept" label="Newly kept" leads={preview.sample_newly_kept} />
      <span className="font-sans text-[10px] leading-snug">
        An estimate: the sweep filters only new postings. Leads already in the pool are never re-filtered, so saving
        changes what comes in next, not what is here now.
      </span>
    </div>
  )
}

function SampleList({ testId, label, leads }: { testId: string; label: string; leads: SweepPreviewLead[] }) {
  if (leads.length === 0) return null
  return (
    <div data-testid={testId} className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest">{label} (sample)</span>
      <ul className="flex flex-col gap-0.5">
        {leads.map((l) => (
          <li key={l.id} className="truncate">
            <span className="text-foreground">{l.company}</span> — {l.title}
            {l.reason ? <span className="text-amber-400"> ({l.reason})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
