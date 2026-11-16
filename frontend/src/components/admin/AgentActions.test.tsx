import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminLead, AgentActionDetail, AgentActionsMeta } from '~/lib/use-admin'

import {
  AgentActionResult,
  enqueueBlockedReason,
  inFlightBriefId,
  LeadAgentActions,
  POLL_ERROR_MAX_MS,
  POLL_MAX_ERRORS,
  POLL_MS,
  pollDelay,
  RecentAgentActions,
  RunNowControls,
  statusText,
} from './AgentActions'

// §24.202 — the agent-action buttons: fixed requests with one optional note,
// fire-and-poll status on the lead, and the results rendered where they belong.

const META: AgentActionsMeta = {
  pause_state: 'active',
  can_enqueue: true,
  daily_cap: 20,
  used_today: 3,
  note_max_chars: 500,
  ttl_minutes: 60,
  guard_minutes: 15,
  compose_authuser: 'jane@example.com',
  run_now: {
    job_scrape: { in_flight_action_id: null, next_scheduled_at: '2026-11-16T18:00:00.000Z', guarded: false },
    daily_briefing: { in_flight_action_id: null, next_scheduled_at: '2026-11-17T08:00:00.000Z', guarded: false },
  },
  kit_rounds: ['SCREENING', 'TECH_SCREEN', 'SYS_DESIGN', 'FINAL'],
}

const LEAD = {
  id: 'lead-1',
  company: 'Globex',
  title: 'Senior Software Engineer',
  application_id: null,
} as unknown as AdminLead

function detail(over: Partial<AgentActionDetail> = {}): AgentActionDetail {
  return {
    id: 'act-1',
    kind: 'research_company',
    series: null,
    lead_id: 'lead-1',
    company: 'Globex',
    title: 'Senior Software Engineer',
    application_id: null,
    round: null,
    note: null,
    status: 'queued',
    error: null,
    created_at: '2026-11-16T10:00:00.000Z',
    started_at: null,
    completed_at: null,
    expires_at: '2026-11-16T11:00:00.000Z',
    has_result: false,
    result_md: null,
    result_json: null,
    progress: [],
    ...over,
  }
}

type Reply = { status: number; body: unknown }

/** Routes: POST /api/admin/actions → `post`; GET /api/admin/actions/<id> →
 *  the next entry of `reads` (the last one repeats); GET the list → `list`. */
function stubApi(opts: { post?: () => Reply; reads?: Reply[]; list?: () => Reply }) {
  const reads = [...(opts.reads ?? [])]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    let out: Reply
    if (init?.method === 'POST') out = opts.post?.() ?? { status: 202, body: { ok: true, action_id: 'act-1' } }
    else if (/\/api\/admin\/actions\/[^/?]+$/.test(u)) out = reads.length > 1 ? reads.shift()! : reads[0]!
    else out = opts.list?.() ?? { status: 200, body: { actions: [], meta: META } }
    return new Response(JSON.stringify(out.body), { status: out.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const reads = (f: ReturnType<typeof stubApi>) =>
  f.mock.calls.filter(([u, i]) => i?.method !== 'POST' && /\/api\/admin\/actions\/[^/?]+$/.test(String(u))).length
const posts = (f: ReturnType<typeof stubApi>) =>
  f.mock.calls.filter(([, i]) => i?.method === 'POST').map(([, i]) => JSON.parse(String(i?.body)) as unknown)

const ok = (d: AgentActionDetail): Reply => ({ status: 200, body: d })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(lead: AdminLead = LEAD, meta: AgentActionsMeta = META, onChanged = vi.fn()) {
  const utils = render(<LeadAgentActions lead={lead} meta={meta} baseUrl="http://x" onChanged={onChanged} />)
  return { ...utils, onChanged }
}

describe('LeadAgentActions — buttons', () => {
  it('offers Research company and Draft outreach; no kit until the lead is an application', () => {
    stubApi({})
    mount()
    expect(screen.getByTestId('agent-action-open-research_company')).toHaveTextContent('Research company')
    expect(screen.getByTestId('agent-action-open-draft_outreach')).toHaveTextContent('Draft outreach')
    expect(screen.queryByTestId('agent-action-open-build_interview_kit')).not.toBeInTheDocument()
    // fixed buttons, not a chat box: nothing to type into until one is chosen
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('a promoted lead adds Build interview kit with a round picker from meta.kit_rounds', () => {
    stubApi({})
    mount({ ...LEAD, application_id: 'app-1' })
    fireEvent.click(screen.getByTestId('agent-action-open-build_interview_kit'))
    const round = screen.getByTestId('agent-action-round') as unknown as HTMLSelectElement
    expect([...round.options].map((o) => o.value)).toEqual(META.kit_rounds)
    expect([...round.options].map((o) => o.text)).toEqual(['Screening', 'Tech screen', 'Sys design', 'Final'])
  })

  it('one optional note; the outreach hint says who it is for or blank for no recipient', () => {
    stubApi({})
    mount()
    fireEvent.click(screen.getByTestId('agent-action-open-draft_outreach'))
    const note = screen.getByTestId('agent-action-note')
    expect(note).toHaveAttribute('placeholder', 'Who it is for, or leave blank for a draft with no recipient')
    expect(note).toHaveAttribute('maxLength', '500')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it.each([
    [{ pause_state: 'paused' as const, can_enqueue: false }, /The agent is paused/],
    [{ can_enqueue: false, used_today: 20 }, /limit is used up \(20 of 20\)/],
    [
      { can_enqueue: false, daily_cap: 0, used_today: 0 },
      /^Agent actions are switched off \(admin_action_daily_cap is 0 on the System tab\)\.$/,
    ],
    [{ can_enqueue: false }, /no ops session/],
  ])('disables the buttons and says why when meta.can_enqueue is false (%o)', (over, why) => {
    stubApi({})
    mount(LEAD, { ...META, ...over })
    expect(screen.getByTestId('agent-action-open-research_company')).toBeDisabled()
    expect(screen.getByTestId('agent-action-open-draft_outreach')).toBeDisabled()
    expect(screen.getByTestId('agent-actions-blocked')).toHaveTextContent(why)
  })

  it('disables the buttons while the lead is in flight (the lock)', async () => {
    const f = stubApi({ reads: [ok(detail({ status: 'running' }))] })
    mount({
      ...LEAD,
      actions: {
        in_flight: true,
        latest: {
          research_company: { id: 'act-1', status: 'running', created_at: 'x', completed_at: null, has_result: false },
        },
      },
    })
    expect(screen.getByTestId('agent-action-open-research_company')).toBeDisabled()
    expect(screen.getByTestId('agent-action-open-draft_outreach')).toBeDisabled()
    await waitFor(() => expect(reads(f)).toBe(1))
  })
})

describe('LeadAgentActions — enqueue + polling', () => {
  it('posts the enqueue (blank note omitted), then polls every POLL_MS until done and stops', async () => {
    const f = stubApi({
      reads: [
        ok(detail({ status: 'queued' })),
        ok(
          detail({
            status: 'running',
            progress: [{ ts: '2026-11-16T10:00:05Z', agent: 'research-company', text: 'reading the careers page' }],
          }),
        ),
        ok(detail({ status: 'done', has_result: true, result_md: '## Globex\n\n- **Founded** 1989' })),
      ],
    })
    const { onChanged } = mount()
    fireEvent.click(screen.getByTestId('agent-action-open-research_company'))
    fireEvent.click(screen.getByTestId('agent-action-submit'))

    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'queued'))
    expect(posts(f)).toEqual([{ action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' }])
    expect(screen.getByTestId('agent-action-status')).toHaveTextContent('queued — waiting for the agent')
    expect(onChanged).toHaveBeenCalledTimes(1)
    // the buttons are locked while it is in flight
    expect(screen.getByTestId('agent-action-open-draft_outreach')).toBeDisabled()

    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'running'))
    expect(screen.getByTestId('agent-action-progress')).toHaveTextContent('research-company: reading the careers page')

    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'done'))
    // the result opens on the lead, rendered as markdown
    const research = screen.getByTestId('agent-action-research')
    // (the shared renderer demotes a ## heading to h3)
    expect(research.querySelector('h3')).toHaveTextContent('Globex')
    expect(research.querySelector('strong')).toHaveTextContent('Founded')
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('agent-action-open-draft_outreach')).toBeEnabled()

    // polling has stopped
    const n = reads(f)
    expect(n).toBe(3)
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3))
    expect(reads(f)).toBe(n)
  })

  it('sends the trimmed note on a lead action', async () => {
    const f = stubApi({ reads: [ok(detail({ status: 'queued' }))] })
    mount()
    fireEvent.click(screen.getByTestId('agent-action-open-research_company'))
    fireEvent.change(screen.getByTestId('agent-action-note'), { target: { value: '  focus on Go  ' } })
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() => expect(posts(f)).toHaveLength(1))
    expect(posts(f)[0]).toEqual({ action: 'enqueue', kind: 'research_company', lead_id: 'lead-1', note: 'focus on Go' })
  })

  it('the kit form has no note field (the host refuses one) and sends only its round', async () => {
    const f = stubApi({ reads: [ok(detail({ kind: 'build_interview_kit', status: 'queued' }))] })
    mount({ ...LEAD, application_id: 'app-1' })
    // A note typed into another action's form first must not ride along.
    fireEvent.click(screen.getByTestId('agent-action-open-research_company'))
    fireEvent.change(screen.getByTestId('agent-action-note'), { target: { value: 'focus on Go' } })
    fireEvent.click(screen.getByTestId('agent-action-open-build_interview_kit'))
    expect(screen.queryByTestId('agent-action-note')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('agent-action-round'), { target: { value: 'TECH_SCREEN' } })
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() => expect(posts(f)).toHaveLength(1))
    expect(posts(f)[0]).toEqual({
      action: 'enqueue',
      kind: 'build_interview_kit',
      lead_id: 'lead-1',
      round: 'TECH_SCREEN',
    })
  })

  it.each([
    [400, 'note_not_supported', /Interview kits do not take a note/],
    [409, 'kit_already_queued', /already queued and will be built on the next run/],
    [500, 'enqueue_failed', /could not queue the action/],
    [500, 'internal_error', /hit an error, so nothing was queued/],
  ])('a %i %s refusal is shown in plain words', async (status, error, text) => {
    stubApi({ post: () => ({ status, body: { error, message: 'host words' } }) })
    mount({ ...LEAD, application_id: 'app-1' })
    fireEvent.click(screen.getByTestId('agent-action-open-build_interview_kit'))
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() => expect(screen.getByTestId('agent-action-error')).toHaveTextContent(text))
    expect(screen.getByTestId('agent-action-error')).not.toHaveTextContent(error)
  })

  it('stops polling on unmount', async () => {
    const f = stubApi({ reads: [ok(detail({ status: 'running' }))] })
    const { unmount } = mount({
      ...LEAD,
      actions: {
        in_flight: true,
        latest: {
          research_company: { id: 'act-1', status: 'running', created_at: 'x', completed_at: null, has_result: false },
        },
      },
    })
    await waitFor(() => expect(reads(f)).toBe(1))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(reads(f)).toBe(2))
    unmount()
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3))
    expect(reads(f)).toBe(2)
  })

  it('resumes polling an in-flight lead on load (its newest queued/running brief)', async () => {
    const f = stubApi({ reads: [ok(detail({ id: 'act-new', kind: 'draft_outreach', status: 'running' }))] })
    const lead = {
      ...LEAD,
      actions: {
        in_flight: true,
        latest: {
          research_company: {
            id: 'act-old',
            status: 'done' as const,
            created_at: '2026-11-16T09:00:00Z',
            completed_at: 'x',
            has_result: true,
          },
          draft_outreach: {
            id: 'act-new',
            status: 'running' as const,
            created_at: '2026-11-16T10:00:00Z',
            completed_at: null,
            has_result: false,
          },
        },
      },
    }
    expect(inFlightBriefId(lead)).toBe('act-new')
    mount(lead)
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'running'))
    expect(String(f.mock.calls[0]![0])).toBe('http://x/api/admin/actions/act-new')
  })

  it('does not poll a lead with nothing in flight', async () => {
    const f = stubApi({})
    mount({
      ...LEAD,
      actions: {
        in_flight: false,
        latest: { research_company: { id: 'a', status: 'done', created_at: 'x', completed_at: 'y', has_result: true } },
      },
    })
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2))
    expect(reads(f)).toBe(0)
  })

  it('pollDelay doubles from POLL_MS after each failed read, capped at the leads poll interval', () => {
    expect(pollDelay(0)).toBe(POLL_MS)
    expect(pollDelay(1)).toBe(POLL_MS * 2)
    expect(pollDelay(2)).toBe(POLL_MS * 4)
    expect(pollDelay(10)).toBe(POLL_ERROR_MAX_MS)
  })

  it('failing status reads back off, stop after POLL_MAX_ERRORS and offer a retry', async () => {
    const inFlightLead = {
      ...LEAD,
      actions: {
        in_flight: true,
        latest: {
          research_company: {
            id: 'act-1',
            status: 'running' as const,
            created_at: 'x',
            completed_at: null,
            has_result: false,
          },
        },
      },
    }
    const fail: Reply = { status: 500, body: { error: 'internal_error' } }
    const f = stubApi({ reads: [ok(detail({ status: 'running' })), ...Array<Reply>(POLL_MAX_ERRORS).fill(fail)] })
    mount(inFlightLead)
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'running'))
    expect(reads(f)).toBe(1)

    // each failure waits longer than the last: not a fixed 2 s loop
    // (half-delay margins: the fake clock also follows real time here)
    let total = 1
    for (let e = 0; e < POLL_MAX_ERRORS; e++) {
      const wait = pollDelay(e)
      if (e > 0) {
        await act(() => vi.advanceTimersByTimeAsync(wait / 2))
        expect(reads(f)).toBe(total) // a fixed POLL_MS loop would have read again
      }
      await act(() => vi.advanceTimersByTimeAsync(e > 0 ? wait / 2 : wait))
      total += 1
      await waitFor(() => expect(reads(f)).toBe(total))
    }
    // stopped, and says so — the last good status stays on screen
    await waitFor(() => expect(screen.getByTestId('agent-action-unavailable')).toBeInTheDocument())
    expect(screen.getByTestId('agent-action-unavailable')).toHaveTextContent('Status unavailable')
    expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'running')
    await act(() => vi.advanceTimersByTimeAsync(POLL_ERROR_MAX_MS * 3))
    expect(reads(f)).toBe(total)

    // retry reads again (the stub now answers with the last failure, so it
    // fails again; swap in a good reply first)
    f.mockImplementation(async () => new Response(JSON.stringify(detail({ status: 'done' })), { status: 200 }))
    fireEvent.click(screen.getByTestId('agent-action-unavailable-retry'))
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'done'))
    expect(screen.queryByTestId('agent-action-unavailable')).not.toBeInTheDocument()
    expect(reads(f)).toBe(total + 1)
  })

  it.each([
    [
      { status: 'failed' as const, error: 'agent finished without a result' },
      'failed — agent finished without a result',
    ],
    [{ status: 'expired' as const }, 'expired — it never started, so nothing ran'],
  ])('a %o action shows its status in plain words and stops polling', async (over, text) => {
    const f = stubApi({ reads: [ok(detail({ status: 'queued' })), ok(detail(over))] })
    mount()
    fireEvent.click(screen.getByTestId('agent-action-open-research_company'))
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'queued'))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveTextContent(text))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3))
    expect(reads(f)).toBe(2)
  })

  it.each([
    [409, { error: 'not_active', pause_state: 'halted' }, /The agent is halted/],
    [409, { error: 'daily_cap', cap: 20, used: 20 }, /limit is used up \(20 of 20\)/],
    [409, { error: 'no_ops_session' }, /no ops session/],
    [400, { error: 'note_too_long', max: 500 }, /at most 500 characters/],
    [400, { error: 'bad_note' }, /plain text/],
    [404, { error: 'unknown_lead' }, /no longer exists/],
    [404, { error: 'agent_actions not migrated' }, /does not support agent actions/],
  ])('a %i %o refusal is shown in plain words and nothing is polled', async (status, body, text) => {
    const f = stubApi({ post: () => ({ status, body }) })
    mount()
    fireEvent.click(screen.getByTestId('agent-action-open-research_company'))
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() => expect(screen.getByTestId('agent-action-error')).toHaveTextContent(text))
    expect(reads(f)).toBe(0)
  })

  it('kit refusals: not promoted and bad round use the host words', async () => {
    stubApi({
      post: () => ({
        status: 400,
        body: { error: 'not_promoted', message: 'Interview kits need an application. Mark the lead applied first.' },
      }),
    })
    mount({ ...LEAD, application_id: 'app-1' })
    fireEvent.click(screen.getByTestId('agent-action-open-build_interview_kit'))
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() =>
      expect(screen.getByTestId('agent-action-error')).toHaveTextContent(
        'Interview kits need an application. Mark the lead applied first.',
      ),
    )
  })

  it('a 409 in_flight shows the message and follows the action already holding the lead', async () => {
    const f = stubApi({
      post: () => ({ status: 409, body: { error: 'in_flight', action_id: 'act-9' } }),
      reads: [ok(detail({ id: 'act-9', kind: 'draft_outreach', status: 'running' }))],
    })
    mount()
    fireEvent.click(screen.getByTestId('agent-action-open-research_company'))
    fireEvent.click(screen.getByTestId('agent-action-submit'))
    await waitFor(() => expect(screen.getByTestId('agent-action-error')).toHaveTextContent(/still queued or running/))
    await waitFor(() => expect(screen.getByTestId('agent-action-status')).toHaveTextContent('Draft outreach: running…'))
    expect(f.mock.calls.some(([u]) => String(u).endsWith('/api/admin/actions/act-9'))).toBe(true)
  })

  it('an earlier result is reachable from the lead: show result fetches and renders it', async () => {
    stubApi({
      reads: [
        ok(
          detail({
            id: 'act-o',
            kind: 'draft_outreach',
            status: 'done',
            has_result: true,
            result_json: { subject: 'Hello Globex', body: 'Hi there', to: null, research_md: null },
          }),
        ),
      ],
    })
    mount({
      ...LEAD,
      actions: {
        in_flight: false,
        latest: {
          draft_outreach: { id: 'act-o', status: 'done', created_at: 'x', completed_at: 'y', has_result: true },
        },
      },
    })
    fireEvent.click(screen.getByTestId('agent-action-history-show-draft_outreach'))
    expect(await screen.findByTestId('agent-action-outreach-subject')).toHaveTextContent('Hello Globex')
  })
})

describe('AgentActionResult', () => {
  it('outreach: subject, body, Copy (subject + blank line + body) and a compose link with a blank recipient', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(
      <AgentActionResult
        authuser="jane@example.com"
        action={detail({
          kind: 'draft_outreach',
          status: 'done',
          has_result: true,
          result_json: { subject: 'R&D at Globex', body: 'Hi,\n\nI build things.', to: null, research_md: '# Notes' },
        })}
      />,
    )
    expect(screen.getByTestId('agent-action-outreach-subject')).toHaveTextContent('R&D at Globex')
    expect(screen.getByTestId('agent-action-outreach-body').textContent).toBe('Hi,\n\nI build things.')
    expect(screen.getByTestId('agent-action-outreach')).toHaveTextContent('no recipient')
    const href = screen.getByTestId('agent-action-compose').getAttribute('href')
    expect(href).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&authuser=jane%40example.com&su=R%26D%20at%20Globex&body=Hi%2C%0A%0AI%20build%20things.',
    )
    expect(href).not.toContain('to=')
    fireEvent.click(screen.getByTestId('agent-action-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('R&D at Globex\n\nHi,\n\nI build things.'))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('agent-action-copy-body'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('Hi,\n\nI build things.'))
  })

  it('outreach whose body was cut mid-emoji still renders, with a compose link', () => {
    const body = `${'x'.repeat(10)}\u{1F680}`.slice(0, 11) // ends in a lone high surrogate
    render(
      <AgentActionResult
        authuser={null}
        action={detail({
          kind: 'draft_outreach',
          status: 'done',
          has_result: true,
          result_json: { subject: 'Hello', body, to: null, research_md: null },
        })}
      />,
    )
    const href = screen.getByTestId('agent-action-compose').getAttribute('href')!
    expect(new URL(href).searchParams.get('body')).toBe(`${'x'.repeat(10)}�`)
  })

  it('outreach with a named recipient puts it in the compose link', () => {
    render(
      <AgentActionResult
        authuser={null}
        action={detail({
          kind: 'draft_outreach',
          status: 'done',
          result_json: { subject: 'S', body: 'B', to: 'hiring@example.com', research_md: null },
        })}
      />,
    )
    expect(screen.getByTestId('agent-action-compose')).toHaveAttribute(
      'href',
      'https://mail.google.com/mail/?view=cm&fs=1&to=hiring%40example.com&su=S&body=B',
    )
  })

  it('a kit renders its document link and round', () => {
    render(
      <AgentActionResult
        authuser={null}
        action={detail({
          kind: 'build_interview_kit',
          status: 'done',
          result_json: {
            kit_url: 'https://docs.example.com/kit',
            title: 'Globex — tech screen kit',
            round: 'TECH_SCREEN',
          },
        })}
      />,
    )
    const kit = screen.getByTestId('agent-action-kit')
    expect(kit.querySelector('a')).toHaveAttribute('href', 'https://docs.example.com/kit')
    expect(kit).toHaveTextContent('Tech screen')
  })

  it('statusText covers every status', () => {
    expect(statusText({ status: 'queued', error: null })).toMatch(/queued/)
    expect(statusText({ status: 'running', error: null })).toBe('running…')
    expect(statusText({ status: 'done', error: null })).toBe('done')
    expect(statusText({ status: 'failed', error: null })).toBe('failed — no reason given')
    expect(statusText({ status: 'expired', error: null })).toMatch(/^expired/)
    expect(enqueueBlockedReason(META)).toBeNull()
  })
})

describe('RunNowControls', () => {
  it('one button per series; a guarded series is disabled with the scheduled time', () => {
    stubApi({})
    render(
      <RunNowControls
        baseUrl="http://x"
        onChanged={vi.fn()}
        meta={{
          ...META,
          run_now: { ...META.run_now, daily_briefing: { ...META.run_now.daily_briefing, guarded: true } },
        }}
      />,
    )
    expect(screen.getByTestId('agent-run-now-job_scrape')).toBeEnabled()
    expect(screen.getByTestId('agent-run-now-job_scrape')).toHaveTextContent('Run job scrape now')
    const briefing = screen.getByTestId('agent-run-now-daily_briefing')
    expect(briefing).toBeDisabled()
    expect(briefing.getAttribute('title')).toMatch(/within 15 minutes/)
  })

  it('posts run_now and follows the action until done', async () => {
    const f = stubApi({
      post: () => ({ status: 202, body: { ok: true, action_id: 'rn-1', status: 'queued' } }),
      reads: [
        ok(detail({ id: 'rn-1', kind: 'run_now', series: 'job_scrape', lead_id: null, status: 'running' })),
        ok(detail({ id: 'rn-1', kind: 'run_now', series: 'job_scrape', lead_id: null, status: 'done' })),
      ],
    })
    const onChanged = vi.fn()
    render(<RunNowControls baseUrl="http://x" onChanged={onChanged} meta={META} />)
    fireEvent.click(screen.getByTestId('agent-run-now-job_scrape'))
    await waitFor(() => expect(screen.getByTestId('agent-run-now-status-job_scrape')).toHaveTextContent('running…'))
    expect(posts(f)).toEqual([{ action: 'run_now', series: 'job_scrape' }])
    expect(screen.getByTestId('agent-run-now-job_scrape')).toBeDisabled()
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(screen.getByTestId('agent-run-now-status-job_scrape')).toHaveTextContent('done'))
    expect(screen.getByTestId('agent-run-now-job_scrape')).toBeEnabled()
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ error: 'duplicate', action_id: 'rn-0' }, /already queued/],
    [{ error: 'run_now_guard', next_scheduled_at: '2026-11-16T18:00:00.000Z', guard_minutes: 15 }, /due soon/],
    [{ error: 'daily_cap', cap: 20, used: 20 }, /limit is used up/],
  ])('a 409 %o is shown in plain words', async (body, text) => {
    stubApi({
      post: () => ({ status: 409, body }),
      reads: [ok(detail({ id: 'rn-0', kind: 'run_now', status: 'queued' }))],
    })
    render(<RunNowControls baseUrl="http://x" onChanged={vi.fn()} meta={META} />)
    fireEvent.click(screen.getByTestId('agent-run-now-job_scrape'))
    await waitFor(() => expect(screen.getByTestId('agent-run-now-error-job_scrape')).toHaveTextContent(text))
  })

  it('resumes a run already in flight from meta', async () => {
    const f = stubApi({
      reads: [ok(detail({ id: 'rn-2', kind: 'run_now', series: 'daily_briefing', status: 'queued' }))],
    })
    render(
      <RunNowControls
        baseUrl="http://x"
        onChanged={vi.fn()}
        meta={{
          ...META,
          run_now: { ...META.run_now, daily_briefing: { ...META.run_now.daily_briefing, in_flight_action_id: 'rn-2' } },
        }}
      />,
    )
    expect(screen.getByTestId('agent-run-now-daily_briefing')).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId('agent-run-now-status-daily_briefing')).toHaveTextContent('queued'))
    expect(String(f.mock.calls[0]![0])).toBe('http://x/api/admin/actions/rn-2')
  })
})

describe('RecentAgentActions', () => {
  it('lists every action when opened, flags a deleted lead, and still shows its result', async () => {
    const f = stubApi({
      list: () => ({
        status: 200,
        body: {
          meta: META,
          actions: [
            detail({
              id: 'gone',
              lead_id: null,
              status: 'done',
              has_result: true,
              company: 'Initech',
              title: 'Backend Engineer',
            }),
            detail({
              id: 'rn',
              kind: 'run_now',
              series: 'daily_briefing',
              lead_id: null,
              company: null,
              title: null,
              status: 'done',
            }),
          ],
        },
      }),
      reads: [
        ok(detail({ id: 'gone', lead_id: null, status: 'done', has_result: true, result_md: 'Initech **research**' })),
      ],
    })
    render(<RecentAgentActions baseUrl="http://x" authuser={null} />)
    expect(f).not.toHaveBeenCalled()
    const details = screen.getByTestId('agent-actions-recent') as HTMLDetailsElement
    details.open = true
    fireEvent(details, new Event('toggle'))
    const rows = await screen.findAllByTestId('agent-actions-recent-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Initech — Backend Engineer')
    expect(screen.getAllByTestId('agent-actions-recent-deleted')).toHaveLength(1)
    expect(rows[1]).toHaveTextContent('Run daily briefing now')
    fireEvent.click(screen.getByTestId('agent-actions-recent-show'))
    expect(await screen.findByTestId('agent-action-research')).toHaveTextContent('Initech research')
    expect(String(f.mock.calls[0]![0])).toBe('http://x/api/admin/actions')
  })
})
