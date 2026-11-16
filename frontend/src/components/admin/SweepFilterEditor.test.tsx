import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SweepFilterPreview } from '~/lib/use-admin'
import type { DevKnob } from '~/lib/use-dev-inspector'

import { parseSweepDraft, previewHeadline, SweepFilterEditor } from './SweepFilterEditor'

// §24.202 D6 — the sweep-filter editor: Save over the existing knob write,
// Preview over the watchlist's preview_filters, and a refused pattern saves nothing.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function knob(key: string, over: Partial<DevKnob> = {}): DevKnob {
  return {
    key,
    value: '',
    default: '',
    overridden: false,
    type: 'text',
    group: 'scouting',
    label: key,
    min: null,
    max: null,
    integer: false,
    options: null,
    maxLength: 1000,
    note: null,
    ...over,
  }
}

const KNOBS: DevKnob[] = [
  knob('ats_sweep_title_include', { value: '\\bengineer\\b', label: 'Sweep: titles to keep (regex)' }),
  knob('ats_sweep_title_exclude', { value: '\\bsales\\b', label: 'Sweep: titles to drop (regex)' }),
  knob('ats_sweep_location_filter', { value: '', label: 'Sweep: locations to keep (regex)' }),
  knob('ats_sweep_max_age_days', {
    type: 'number',
    value: 30,
    default: 30,
    min: 1,
    max: 365,
    integer: true,
    maxLength: null,
    label: 'Sweep: max posting age (days)',
  }),
  knob('ats_sweep_max_new_per_run', {
    type: 'number',
    value: 40,
    default: 40,
    min: 0,
    max: 500,
    integer: true,
    maxLength: null,
    overridden: true,
    label: 'Sweep: max new leads per run',
  }),
  // an unrelated knob is ignored
  knob('lead_stale_days', { type: 'number', value: 14 }),
]

const PREVIEW: SweepFilterPreview = {
  ok: true,
  total: 120,
  current: { keep: 90, drop: 30, drop_by_reason: { filter: 30 } },
  proposed: { keep: 84, drop: 36, drop_by_reason: { filter: 30, location: 6 } },
  newly_dropped: 6,
  newly_kept: 0,
  sample_newly_dropped: [{ id: 'l1', title: 'Platform Engineer', company: 'Globex', reason: 'location' }],
  sample_newly_kept: [],
}

type Reply = { status: number; body: unknown }

/** Route the editor's two endpoints: preview (watchlist) and knob writes. */
function stubApi(
  opts: { preview?: (b: Record<string, unknown>) => Reply; knob?: (b: Record<string, unknown>) => Reply } = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    let out: Reply = { status: 200, body: { ok: true } }
    if (String(url).endsWith('/api/admin/watchlist')) out = opts.preview?.(body) ?? { status: 200, body: PREVIEW }
    if (String(url).endsWith('/api/admin/knobs'))
      out = opts.knob?.(body) ?? { status: 200, body: { key: body.key, value: body.value, applied: true } }
    return new Response(JSON.stringify(out.body), { status: out.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function calls(fetchMock: ReturnType<typeof stubApi>, path: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(path))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

function renderEditor(knobs: DevKnob[] = KNOBS, onSaved = vi.fn()) {
  render(<SweepFilterEditor knobs={knobs} baseUrl="http://x" onSaved={onSaved} />)
  return onSaved
}

const input = (key: string) => screen.getByTestId(`sweep-input-${key}`)

describe('SweepFilterEditor', () => {
  it('is hidden when the host has none of the sweep knobs', () => {
    const { container } = render(
      <SweepFilterEditor knobs={[knob('lead_stale_days')]} baseUrl="http://x" onSaved={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the five filter knobs with their stored values; Save starts disabled', () => {
    renderEditor()
    expect(input('ats_sweep_title_include')).toHaveValue('\\bengineer\\b')
    expect(input('ats_sweep_max_age_days')).toHaveValue(30)
    expect(input('ats_sweep_max_new_per_run')).toHaveValue(40)
    expect(screen.queryByTestId('sweep-field-lead_stale_days')).not.toBeInTheDocument()
    expect(screen.getByTestId('sweep-save')).toBeDisabled()
    // only an overridden knob offers a reset
    expect(screen.getByTestId('sweep-reset-ats_sweep_max_new_per_run')).toBeInTheDocument()
    expect(screen.queryByTestId('sweep-reset-ats_sweep_title_include')).not.toBeInTheDocument()
  })

  it('saves the changed keys only, in the fixed order, after the host checks the patterns', async () => {
    const f = stubApi()
    const onSaved = renderEditor()
    fireEvent.change(input('ats_sweep_max_new_per_run'), { target: { value: '25' } })
    fireEvent.change(input('ats_sweep_title_include'), { target: { value: '\\b(engineer|developer)\\b' } })
    expect(screen.getByTestId('sweep-save')).toHaveTextContent('Save 2 changes')
    fireEvent.click(screen.getByTestId('sweep-save'))
    expect(await screen.findByTestId('sweep-note')).toHaveTextContent('Saved 2 filters. The next sweep uses them.')
    expect(calls(f, '/api/admin/watchlist')).toEqual([
      { action: 'preview_filters', filters: { ats_sweep_title_include: '\\b(engineer|developer)\\b' } },
    ])
    expect(calls(f, '/api/admin/knobs')).toEqual([
      { key: 'ats_sweep_title_include', value: '\\b(engineer|developer)\\b' },
      { key: 'ats_sweep_max_new_per_run', value: 25 },
    ])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('a pattern that does not compile shows the host message inline and saves nothing', async () => {
    const message = 'ats_sweep_title_exclude is not a valid regular expression: Unterminated group'
    const f = stubApi({
      preview: () => ({ status: 400, body: { error: 'invalid_filter', field: 'ats_sweep_title_exclude', message } }),
    })
    const onSaved = renderEditor()
    fireEvent.change(input('ats_sweep_title_include'), { target: { value: 'engineer' } })
    fireEvent.change(input('ats_sweep_title_exclude'), { target: { value: '(sales' } })
    fireEvent.click(screen.getByTestId('sweep-save'))
    expect(await screen.findByTestId('sweep-field-error')).toHaveTextContent(message)
    expect(screen.getByTestId('sweep-field-ats_sweep_title_exclude')).toContainElement(
      screen.getByTestId('sweep-field-error'),
    )
    expect(calls(f, '/api/admin/knobs')).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
    // the edits stay for the owner to fix
    expect(input('ats_sweep_title_exclude')).toHaveValue('(sales')
  })

  it('on a host without the preview, the knob write is the check: its 400 shows inline and stops', async () => {
    const message = 'ats_sweep_title_include is not a valid regular expression: Unterminated group'
    const f = stubApi({
      preview: () => ({ status: 400, body: { error: 'unknown action: preview_filters' } }),
      knob: (b) =>
        b.key === 'ats_sweep_title_include'
          ? { status: 400, body: { error: message } }
          : { status: 200, body: { key: b.key, value: b.value, applied: true } },
    })
    const onSaved = renderEditor()
    fireEvent.change(input('ats_sweep_title_include'), { target: { value: '(' } })
    fireEvent.change(input('ats_sweep_max_age_days'), { target: { value: '14' } })
    fireEvent.click(screen.getByTestId('sweep-save'))
    expect(await screen.findByTestId('sweep-field-error')).toHaveTextContent(message)
    // the first key in order was refused, so nothing after it was sent
    expect(calls(f, '/api/admin/knobs')).toEqual([{ key: 'ats_sweep_title_include', value: '(' }])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('stops at the first refused write and says which keys were already saved', async () => {
    const f = stubApi({
      knob: (b) =>
        b.key === 'ats_sweep_max_new_per_run'
          ? { status: 400, body: { error: 'ats_sweep_max_new_per_run must be ≤ 500' } }
          : { status: 200, body: { key: b.key, value: b.value, applied: true } },
    })
    // a host whose bounds differ from the client's copy: the client lets 450 through
    const knobs = KNOBS.map((k) => (k.key === 'ats_sweep_max_new_per_run' ? { ...k, max: 1000 } : k))
    const onSaved = renderEditor(knobs)
    fireEvent.change(input('ats_sweep_max_age_days'), { target: { value: '14' } })
    fireEvent.change(input('ats_sweep_max_new_per_run'), { target: { value: '900' } })
    fireEvent.click(screen.getByTestId('sweep-save'))
    expect(await screen.findByTestId('sweep-field-error')).toHaveTextContent('ats_sweep_max_new_per_run must be ≤ 500')
    expect(screen.getByTestId('sweep-error')).toHaveTextContent(
      'Saved ats_sweep_max_age_days before ats_sweep_max_new_per_run was refused.',
    )
    expect(calls(f, '/api/admin/knobs').map((b) => b.key)).toEqual([
      'ats_sweep_max_age_days',
      'ats_sweep_max_new_per_run',
    ])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('an out-of-range number is refused before any request', async () => {
    const f = stubApi()
    renderEditor()
    fireEvent.change(input('ats_sweep_max_age_days'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('sweep-save'))
    expect(await screen.findByTestId('sweep-field-error')).toHaveTextContent('ats_sweep_max_age_days must be ≥ 1')
    expect(f).not.toHaveBeenCalled()
  })

  it('Preview sends the proposal (not the per-run cap) and shows counts, samples and the estimate note', async () => {
    const f = stubApi()
    renderEditor()
    fireEvent.change(input('ats_sweep_location_filter'), { target: { value: 'remote|us' } })
    fireEvent.change(input('ats_sweep_max_age_days'), { target: { value: '21' } })
    fireEvent.change(input('ats_sweep_max_new_per_run'), { target: { value: '10' } })
    fireEvent.click(screen.getByTestId('sweep-preview'))
    expect(await screen.findByTestId('sweep-preview-headline')).toHaveTextContent(
      'Of 120 open board leads: current filters keep 90, these keep 84 (6 newly dropped, 0 newly kept).',
    )
    expect(calls(f, '/api/admin/watchlist')).toEqual([
      { action: 'preview_filters', filters: { ats_sweep_location_filter: 'remote|us', ats_sweep_max_age_days: 21 } },
    ])
    expect(calls(f, '/api/admin/knobs')).toEqual([])
    expect(screen.getByTestId('sweep-preview-dropped')).toHaveTextContent('Globex — Platform Engineer (location)')
    expect(screen.queryByTestId('sweep-preview-kept')).not.toBeInTheDocument()
    expect(screen.getByTestId('sweep-preview-result')).toHaveTextContent('An estimate')
  })

  it('Preview of an uncompilable pattern shows the host message on that field', async () => {
    stubApi({
      preview: () => ({
        status: 400,
        body: { error: 'invalid_filter', field: 'ats_sweep_location_filter', message: 'bad pattern' },
      }),
    })
    renderEditor()
    fireEvent.change(input('ats_sweep_location_filter'), { target: { value: '[' } })
    fireEvent.click(screen.getByTestId('sweep-preview'))
    expect(await screen.findByTestId('sweep-field-error')).toHaveTextContent('bad pattern')
    expect(screen.getByTestId('sweep-field-ats_sweep_location_filter')).toContainElement(
      screen.getByTestId('sweep-field-error'),
    )
    expect(screen.queryByTestId('sweep-preview-result')).not.toBeInTheDocument()
  })

  it('Preview on a host without it says so', async () => {
    stubApi({ preview: () => ({ status: 404, body: { error: 'not_found' } }) })
    renderEditor()
    fireEvent.click(screen.getByTestId('sweep-preview'))
    expect(await screen.findByTestId('sweep-error')).toHaveTextContent('This server cannot preview filters yet.')
  })

  it('reset to default posts the reset and refreshes', async () => {
    const f = stubApi()
    const onSaved = renderEditor()
    fireEvent.click(screen.getByTestId('sweep-reset-ats_sweep_max_new_per_run'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(calls(f, '/api/admin/knobs')).toEqual([{ key: 'ats_sweep_max_new_per_run', reset: true }])
    expect(screen.getByTestId('sweep-note')).toHaveTextContent('Sweep: max new leads per run is back to its default.')
  })

  it('discard drops the edits', () => {
    renderEditor()
    fireEvent.change(input('ats_sweep_title_include'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('sweep-discard'))
    expect(input('ats_sweep_title_include')).toHaveValue('\\bengineer\\b')
    expect(screen.getByTestId('sweep-save')).toBeDisabled()
  })
})

describe('parseSweepDraft / previewHeadline', () => {
  const age = KNOBS[3] as DevKnob
  const inc = KNOBS[0] as DevKnob
  it('checks numbers against the knob bounds and texts against maxLength', () => {
    expect(parseSweepDraft(age, '14')).toEqual({ ok: true, value: 14 })
    expect(parseSweepDraft(age, '')).toEqual({ ok: false, message: 'ats_sweep_max_age_days must be a number' })
    expect(parseSweepDraft(age, '1.5')).toEqual({ ok: false, message: 'ats_sweep_max_age_days must be an integer' })
    expect(parseSweepDraft(age, '400')).toEqual({ ok: false, message: 'ats_sweep_max_age_days must be ≤ 365' })
    expect(parseSweepDraft(inc, '')).toEqual({ ok: true, value: '' })
    expect(parseSweepDraft(inc, 'x'.repeat(1001))).toEqual({
      ok: false,
      message: 'ats_sweep_title_include must be ≤ 1000 characters',
    })
  })

  it('previewHeadline pluralises', () => {
    expect(previewHeadline({ ...PREVIEW, total: 1 })).toMatch(/^Of 1 open board lead:/)
  })
})
