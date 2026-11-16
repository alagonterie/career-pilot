import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  agentActionRefusalMessage,
  fetchAdminAction,
  fetchAdminActions,
  gmailComposeUrl,
  isActionInFlight,
  postAdminAction,
  refusalActionId,
  roundLabel,
  toWellFormedString,
  type AdminActionOutcome,
} from './use-admin'

// §24.203 — the agent-action helpers: the compose link, the write's outcome
// mapping, and a plain sentence for every refusal the actions route returns.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function reply(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('gmailComposeUrl', () => {
  it('leaves the recipient out when the draft has none (null, undefined or empty)', () => {
    const base = 'https://mail.google.com/mail/?view=cm&fs=1&su=Hello&body=Hi'
    expect(gmailComposeUrl({ subject: 'Hello', body: 'Hi', to: null })).toBe(base)
    expect(gmailComposeUrl({ subject: 'Hello', body: 'Hi' })).toBe(base)
    expect(gmailComposeUrl({ subject: 'Hello', body: 'Hi', to: '' })).toBe(base)
    expect(gmailComposeUrl({ subject: 'Hello', body: 'Hi', to: null })).not.toContain('to=')
  })

  it('adds the recipient when the draft names one', () => {
    expect(gmailComposeUrl({ subject: 'S', body: 'B', to: 'jane@example.com' })).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&to=jane%40example.com&su=S&body=B',
    )
  })

  it('adds authuser before the recipient, only when it is a non-empty string', () => {
    expect(gmailComposeUrl({ subject: 'S', body: 'B', to: 'a@example.com', authuser: 'me@example.com' })).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&authuser=me%40example.com&to=a%40example.com&su=S&body=B',
    )
    expect(gmailComposeUrl({ subject: 'S', body: 'B', authuser: '' })).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&su=S&body=B',
    )
    expect(gmailComposeUrl({ subject: 'S', body: 'B', authuser: null })).not.toContain('authuser')
  })

  it('percent-encodes &, +, spaces, newlines and non-ASCII (never + for a space)', () => {
    const url = gmailComposeUrl({ subject: 'R&D + you', body: 'Hi Jané,\n\nC++ & Go — ok?' })
    expect(url).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&su=R%26D%20%2B%20you&body=Hi%20Jan%C3%A9%2C%0A%0AC%2B%2B%20%26%20Go%20%E2%80%94%20ok%3F',
    )
    // the round trip is lossless
    const parsed = new URL(url)
    expect(parsed.searchParams.get('su')).toBe('R&D + you')
    expect(parsed.searchParams.get('body')).toBe('Hi Jané,\n\nC++ & Go — ok?')
  })

  it('never throws on a lone surrogate (an emoji cut in half by the host length cap)', () => {
    const emoji = '\u{1F680}' // two UTF-16 code units
    const body = `Thanks ${emoji}`.slice(0, -1) // ends in a lone high surrogate
    const subject = `\uDE80 low first` // lone low surrogate
    expect(() => encodeURIComponent(body)).toThrow(URIError) // the failure this guards
    const url = gmailComposeUrl({ subject, body, to: `a${emoji.slice(0, 1)}@example.com`, authuser: '\uD83D' })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('body')).toBe('Thanks �')
    expect(parsed.searchParams.get('su')).toBe('� low first')
    expect(parsed.searchParams.get('to')).toBe('a�@example.com')
    expect(parsed.searchParams.get('authuser')).toBe('�')
  })

  it('toWellFormedString keeps valid pairs and replaces only lone halves', () => {
    expect(toWellFormedString('ok \u{1F680} ok')).toBe('ok \u{1F680} ok')
    expect(toWellFormedString('\uD83D🚀')).toBe('�\u{1F680}')
    expect(toWellFormedString('\uDE80\uDE80')).toBe('��')
  })
})

describe('postAdminAction', () => {
  it('maps a 202 to queued with the action id and posts the body as given', async () => {
    const f = reply(202, { ok: true, action_id: 'act-1', status: 'queued' })
    const out = await postAdminAction('http://x', {
      action: 'enqueue',
      kind: 'draft_outreach',
      lead_id: 'lead-1',
      note: 'for the hiring manager',
    })
    expect(out).toEqual({ kind: 'queued', action_id: 'act-1' })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('http://x/api/admin/actions')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'enqueue',
      kind: 'draft_outreach',
      lead_id: 'lead-1',
      note: 'for the hiring manager',
    })
  })

  it('maps every non-2xx to refused with the host body', async () => {
    reply(409, { error: 'in_flight', action_id: 'act-0' })
    const out = await postAdminAction('http://x', { action: 'enqueue', kind: 'research_company', lead_id: 'l' })
    expect(out).toEqual({
      kind: 'refused',
      status: 409,
      error: 'in_flight',
      data: { error: 'in_flight', action_id: 'act-0' },
    })
    expect(refusalActionId(out)).toBe('act-0')
  })

  it('a network failure is refused with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const out = await postAdminAction('http://x', { action: 'run_now', series: 'job_scrape' })
    expect(out).toMatchObject({ kind: 'refused', status: 0, error: 'offline' })
    expect(agentActionRefusalMessage(out as Extract<AdminActionOutcome, { kind: 'refused' }>)).toBe(
      'Could not reach the server (offline).',
    )
  })
})

describe('agentActionRefusalMessage — every refusal in plain words', () => {
  const msg = (status: number, data: Record<string, unknown>) =>
    agentActionRefusalMessage({ kind: 'refused', status, error: String(data.error), data })

  it.each([
    [404, { error: 'agent_actions not migrated' }, 'This host does not support agent actions yet.'],
    [400, { error: 'bad_kind' }, 'That action is not one the agent knows.'],
    [400, { error: 'bad_series' }, 'That schedule cannot be run now.'],
    [400, { error: 'lead_id_required' }, 'No lead was given.'],
    [400, { error: 'bad_note' }, 'The note must be plain text.'],
    [400, { error: 'note_too_long', max: 500 }, 'The note is too long — at most 500 characters.'],
    [404, { error: 'unknown_lead' }, 'That lead no longer exists.'],
    [
      400,
      { error: 'not_promoted', message: 'Interview kits need an application. Mark the lead applied first.' },
      'Interview kits need an application. Mark the lead applied first.',
    ],
    [
      400,
      { error: 'bad_round', allowed: ['SCREENING', 'TECH_SCREEN'] },
      'Pick one of the interview rounds: Screening, Tech screen.',
    ],
    [
      409,
      { error: 'not_active', pause_state: 'paused' },
      'The agent is paused, so nothing was queued. Resume it on the Overview tab first.',
    ],
    [
      409,
      { error: 'in_flight', action_id: 'a' },
      'Another agent action for this lead is still queued or running — wait for it to finish.',
    ],
    [409, { error: 'duplicate', action_id: 'a' }, 'A run for this schedule is already queued — wait for it to finish.'],
    [
      409,
      { error: 'daily_cap', cap: 10, used: 10 },
      "Today's agent-action limit is used up (10 of 10). It resets at midnight UTC.",
    ],
    [
      409,
      { error: 'daily_cap', cap: 0, used: 0 },
      'Agent actions are switched off (admin_action_daily_cap is 0 on the System tab).',
    ],
    [409, { error: 'no_ops_session' }, 'The agent has no ops session running, so nothing can be queued yet.'],
    [
      400,
      { error: 'note_not_supported', message: 'x' },
      'Interview kits do not take a note. Clear the note and press again.',
    ],
    [
      409,
      { error: 'kit_already_queued', message: 'x' },
      'A kit for that round is already queued and will be built on the next run.',
    ],
    [500, { error: 'enqueue_failed' }, 'The host could not queue the action. Nothing was started; try again.'],
    [
      500,
      { error: 'internal_error' },
      'The host hit an error, so nothing was queued. Try again; if it keeps happening, check the host logs.',
    ],
  ])('%i %o', (status, data, expected) => {
    expect(msg(status, data)).toBe(expected)
  })

  it('run_now_guard names the scheduled time and the guard window', () => {
    const at = '2026-11-16T12:00:00.000Z'
    const text = msg(409, { error: 'run_now_guard', next_scheduled_at: at, guard_minutes: 15 })
    expect(text).toContain(new Date(at).toLocaleString())
    expect(text).toContain('within 15 minutes')
    expect(text).toMatch(/not started now\.$/)
  })

  it('an unknown error falls back to the host string', () => {
    expect(msg(500, { error: 'boom' })).toBe('boom')
  })

  it('a duplicate whose holder has no row (action_id null) follows nothing but still reads plainly', () => {
    const out = {
      kind: 'refused' as const,
      status: 409,
      error: 'duplicate',
      data: { error: 'duplicate', action_id: null },
    }
    expect(refusalActionId(out)).toBeNull()
    expect(agentActionRefusalMessage(out)).toBe('A run for this schedule is already queued — wait for it to finish.')
  })

  it('refusalActionId is null for any refusal that does not name a holder', () => {
    expect(refusalActionId({ kind: 'refused', status: 409, error: 'daily_cap', data: { action_id: 'x' } })).toBeNull()
    expect(refusalActionId({ kind: 'queued', action_id: 'x' })).toBeNull()
  })
})

describe('reads', () => {
  it('fetchAdminActions passes lead_id encoded and returns actions + meta', async () => {
    const f = reply(200, { actions: [{ id: 'a' }], meta: { can_enqueue: true } })
    const out = await fetchAdminActions('http://x', 'lead 1/2')
    expect(f.mock.calls[0]![0]).toBe('http://x/api/admin/actions?lead_id=lead%201%2F2')
    expect(out?.actions).toHaveLength(1)
  })

  it('fetchAdminActions is null on a host without the route', async () => {
    reply(404, { error: 'not_found' })
    expect(await fetchAdminActions('http://x')).toBeNull()
  })

  it('fetchAdminAction: ok, not_found on 404, error otherwise', async () => {
    reply(200, { id: 'a', status: 'running' })
    expect(await fetchAdminAction('http://x', 'a')).toMatchObject({ kind: 'ok', action: { id: 'a' } })
    reply(404, { error: 'not_found' })
    expect(await fetchAdminAction('http://x', 'a')).toEqual({ kind: 'not_found' })
    reply(500, {})
    expect(await fetchAdminAction('http://x', 'a')).toEqual({ kind: 'error', status: 500 })
  })

  it('isActionInFlight + roundLabel', () => {
    expect(isActionInFlight('queued')).toBe(true)
    expect(isActionInFlight('running')).toBe(true)
    for (const s of ['done', 'failed', 'expired'] as const) expect(isActionInFlight(s)).toBe(false)
    expect(roundLabel('SYS_DESIGN')).toBe('Sys design')
    expect(roundLabel('FINAL')).toBe('Final')
  })
})
