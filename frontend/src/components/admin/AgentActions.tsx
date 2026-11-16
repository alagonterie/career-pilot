import { useCallback, useEffect, useRef, useState } from 'react'

import { renderMarkdownish } from '~/lib/markdownish'
import {
  AGENT_ACTIONS_OFF_MESSAGE,
  agentActionRefusalMessage,
  fetchAdminAction,
  fetchAdminActions,
  gmailComposeUrl,
  isActionInFlight,
  isKitResult,
  isOutreachResult,
  LEAD_ACTION_KINDS,
  postAdminAction,
  refusalActionId,
  roundLabel,
  RUN_NOW_SERIES,
  type AdminLead,
  type AgentActionDetail,
  type AgentActionKind,
  type AgentActionRow,
  type AgentActionsMeta,
  type AgentActionStatus,
  type LeadActionKind,
  type RunNowSeries,
} from '~/lib/use-admin'
import { cn } from '~/lib/utils'

/**
 * §24.202 — the agent-action buttons on `/admin`. Fixed requests with one
 * optional note, not a chat box: per lead *Research company* and *Draft
 * outreach* (plus *Build interview kit* once the lead is an application), and a
 * global *Run now* for the job-scrape and daily-briefing series.
 *
 * Fire-and-poll, like TailorResume: the host answers 202 with the action id and
 * a queued row that is also the per-lead lock; the page polls that one action
 * every POLL_MS while it is queued or running and stops on done / failed /
 * expired or unmount. A 409 that names the action already holding the lock
 * (`in_flight` / `duplicate`) joins that poll instead of retrying.
 *
 * Results land on the lead — research as markdown, outreach as subject + body
 * with Copy and an "Open in Gmail" compose link (recipient blank unless the
 * draft names one), a kit as its document link. A result outlives its lead:
 * the "Recent agent actions" list reaches it after the lead is deleted.
 */
export const POLL_MS = 2000
/** A failed status read backs off by doubling, up to the leads poll interval. */
export const POLL_ERROR_MAX_MS = 20000
/** After this many failed status reads in a row the poll stops and offers a retry. */
export const POLL_MAX_ERRORS = 5

/** The delay before the next read after `errors` failed reads in a row. */
export function pollDelay(errors: number): number {
  return errors <= 0 ? POLL_MS : Math.min(POLL_MS * 2 ** errors, POLL_ERROR_MAX_MS)
}

export const ACTION_LABEL: Record<AgentActionKind, string> = {
  research_company: 'Research company',
  draft_outreach: 'Draft outreach',
  build_interview_kit: 'Build interview kit',
  run_now: 'Run now',
}

export const SERIES_LABEL: Record<RunNowSeries, string> = {
  job_scrape: 'job scrape',
  daily_briefing: 'daily briefing',
}

/** The kinds that take a note, with its hint. A kit takes none: the host builds
 *  it from the application and the round alone (a note is refused with 400
 *  `note_not_supported`), so its form has no note field. */
const NOTE_HINT: Partial<Record<LeadActionKind, string>> = {
  research_company: 'Anything to focus on (optional)',
  draft_outreach: 'Who it is for, or leave blank for a draft with no recipient',
}

export function takesNote(kind: LeadActionKind): boolean {
  return NOTE_HINT[kind] !== undefined
}

const BUTTON =
  'rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50'

function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** Why the buttons are off, in plain words — null when they are on. */
export function enqueueBlockedReason(meta: AgentActionsMeta): string | null {
  if (meta.can_enqueue) return null
  if (meta.pause_state !== 'active') {
    return `The agent is ${meta.pause_state} — agent actions are off until it is resumed on the Overview tab.`
  }
  if (meta.daily_cap === 0) return AGENT_ACTIONS_OFF_MESSAGE
  if (meta.used_today >= meta.daily_cap) {
    return `Today's agent-action limit is used up (${meta.used_today} of ${meta.daily_cap}). It resets at midnight UTC.`
  }
  return 'The agent has no ops session running, so nothing can be queued yet.'
}

/** One line per status, in plain words. */
export function statusText(a: Pick<AgentActionRow, 'status' | 'error'>): string {
  switch (a.status) {
    case 'queued':
      return 'queued — waiting for the agent'
    case 'running':
      return 'running…'
    case 'done':
      return 'done'
    case 'failed':
      return `failed — ${a.error ?? 'no reason given'}`
    case 'expired':
      return 'expired — it never started, so nothing ran'
  }
}

const STATUS_TONE: Record<AgentActionStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-accent-cool',
  done: 'text-primary',
  failed: 'text-destructive',
  expired: 'text-amber-400',
}

// ── polling ──────────────────────────────────────────────────────────────────

/**
 * Follow one action: read it now, then every POLL_MS while it is queued or
 * running. A failed read backs off (`pollDelay`) and, after POLL_MAX_ERRORS in
 * a row, stops with `unavailable` set until `retry()`; a 404 stops. `onSettled`
 * fires once when a followed action reaches done / failed / expired.
 */
export function useActionPoll(
  baseUrl: string,
  id: string | null,
  onSettled?: (a: AgentActionDetail) => void,
): { action: AgentActionDetail | null; lost: boolean; unavailable: boolean; retry: () => void } {
  const [action, setAction] = useState<AgentActionDetail | null>(null)
  const [lost, setLost] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const settled = useRef(onSettled)
  settled.current = onSettled
  const sawInFlight = useRef(false)
  const lastId = useRef<string | null>(null)

  useEffect(() => {
    // A new action starts clean; a retry of the same one keeps what it showed.
    if (lastId.current !== id) {
      lastId.current = id
      sawInFlight.current = false
      setAction(null)
    }
    setLost(false)
    setUnavailable(false)
    if (!id) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let errors = 0
    const tick = async (): Promise<void> => {
      const out = await fetchAdminAction(baseUrl, id)
      if (!alive) return
      if (out.kind === 'not_found') {
        setLost(true)
        return
      }
      if (out.kind === 'ok') {
        errors = 0
        setUnavailable(false)
        setAction(out.action)
        if (!isActionInFlight(out.action.status)) {
          if (sawInFlight.current) settled.current?.(out.action)
          return
        }
        sawInFlight.current = true
      } else {
        errors += 1
        if (errors >= POLL_MAX_ERRORS) {
          setUnavailable(true)
          return
        }
      }
      timer = setTimeout(() => void tick(), pollDelay(errors))
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [baseUrl, id, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { action, lost, unavailable, retry }
}

/** Shown when the status reads keep failing and the poll has stopped. */
function PollUnavailable({ onRetry, testId }: { onRetry: () => void; testId: string }) {
  return (
    <span data-testid={testId} role="status" className="flex items-center gap-2 font-mono text-[10px] text-amber-400">
      Status unavailable — the server did not answer.
      <button
        type="button"
        data-testid={`${testId}-retry`}
        onClick={onRetry}
        className="text-accent-cool hover:underline"
      >
        retry
      </button>
    </span>
  )
}

// ── status + results ────────────────────────────────────────────────────────

export function ActionStatus({ action }: { action: AgentActionDetail }) {
  const progress = action.progress ?? []
  return (
    <div data-testid="agent-action-status" data-status={action.status} className="flex flex-col gap-1">
      <span className={cn('font-mono text-[11px]', STATUS_TONE[action.status])}>
        {ACTION_LABEL[action.kind]}
        {action.round ? ` (${roundLabel(action.round)})` : ''}: {statusText(action)}
      </span>
      {action.status === 'running' && progress.length > 0 ? (
        <ul data-testid="agent-action-progress" className="flex flex-col gap-0.5 pl-3">
          {progress.map((p, i) => (
            <li key={`${p.ts}-${i}`} className="font-mono text-[10px] text-muted-foreground">
              {p.agent ? <span className="text-foreground/70">{p.agent}: </span> : null}
              {p.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return (
    <button type="button" data-testid={testId} onClick={() => void copy()} className={BUTTON}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  )
}

/** A finished action's result: research as markdown, outreach as subject +
 *  body with Copy and a compose link, a kit as its document link. */
export function AgentActionResult({ action, authuser }: { action: AgentActionDetail; authuser: string | null }) {
  const outreach = isOutreachResult(action.result_json) ? action.result_json : null
  const kit = isKitResult(action.result_json) ? action.result_json : null
  if (action.status === 'failed' || action.status === 'expired') {
    return (
      <p data-testid="agent-action-result-none" className={cn('font-mono text-[11px]', STATUS_TONE[action.status])}>
        {statusText(action)}
      </p>
    )
  }
  if (outreach) {
    const full = `${outreach.subject}\n\n${outreach.body}`
    return (
      <div data-testid="agent-action-outreach" className="flex max-w-2xl flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">subject</span>
          <span data-testid="agent-action-outreach-subject" className="text-sm text-foreground">
            {outreach.subject}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            body{outreach.to ? ` · to ${outreach.to}` : ' · no recipient'}
          </span>
          <pre
            data-testid="agent-action-outreach-body"
            className="whitespace-pre-wrap rounded-md border border-border/60 bg-background p-2 font-sans text-[12px] leading-relaxed text-foreground"
          >
            {outreach.body}
          </pre>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={full} label="Copy" testId="agent-action-copy" />
          <CopyButton text={outreach.body} label="Copy body" testId="agent-action-copy-body" />
          <a
            data-testid="agent-action-compose"
            href={gmailComposeUrl({ ...outreach, authuser })}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent-cool hover:underline"
          >
            Open in Gmail ↗
          </a>
        </div>
        {outreach.research_md || action.result_md ? (
          <details className="text-[12px]">
            <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
              the research it was written from
            </summary>
            <div className="mt-2">{renderMarkdownish(outreach.research_md ?? action.result_md ?? '')}</div>
          </details>
        ) : null}
      </div>
    )
  }
  if (kit) {
    return (
      <p data-testid="agent-action-kit" className="font-mono text-[11px]">
        <a href={kit.kit_url} target="_blank" rel="noreferrer" className="text-accent-cool hover:underline">
          {kit.title} ↗
        </a>
        <span className="text-muted-foreground"> · {roundLabel(kit.round)}</span>
      </p>
    )
  }
  if (action.result_md) {
    return (
      <div data-testid="agent-action-research" className="max-w-prose text-[12px]">
        {renderMarkdownish(action.result_md)}
      </div>
    )
  }
  return (
    <p data-testid="agent-action-result-none" className="font-mono text-[11px] text-muted-foreground">
      {action.kind === 'run_now' ? 'Finished — a Run now has no stored result.' : 'No result was stored.'}
    </p>
  )
}

/** Fetch one action on demand and render its result. */
function ResultLoader({ baseUrl, id, authuser }: { baseUrl: string; id: string; authuser: string | null }) {
  const [state, setState] = useState<AgentActionDetail | 'loading' | 'missing'>('loading')
  useEffect(() => {
    let alive = true
    void fetchAdminAction(baseUrl, id).then((out) => {
      if (alive) setState(out.kind === 'ok' ? out.action : 'missing')
    })
    return () => {
      alive = false
    }
  }, [baseUrl, id])
  if (state === 'loading') return <p className="font-mono text-[11px] text-muted-foreground">Loading…</p>
  if (state === 'missing') {
    return (
      <p data-testid="agent-action-result-missing" className="font-mono text-[11px] text-destructive">
        The result could not be loaded.
      </p>
    )
  }
  return <AgentActionResult action={state} authuser={authuser} />
}

// ── per lead ────────────────────────────────────────────────────────────────

/** The newest queued/running brief on the lead — the one to resume polling. */
export function inFlightBriefId(lead: Pick<AdminLead, 'actions'>): string | null {
  const latest = lead.actions?.latest
  if (!lead.actions?.in_flight || !latest) return null
  let best: { id: string; created_at: string } | null = null
  for (const k of LEAD_ACTION_KINDS) {
    const b = latest[k]
    if (b && isActionInFlight(b.status) && (!best || b.created_at > best.created_at)) best = b
  }
  return best?.id ?? null
}

/**
 * The buttons (inline, after "I applied") plus a full-width line under them for
 * the note form, the live status and the results. Rendered only when the host
 * sends `agentActions`.
 */
export function LeadAgentActions({
  lead,
  meta,
  baseUrl,
  onChanged,
}: {
  lead: AdminLead
  meta: AgentActionsMeta
  baseUrl: string
  onChanged: () => void
}) {
  const [form, setForm] = useState<LeadActionKind | null>(null)
  const [note, setNote] = useState('')
  const [round, setRound] = useState(meta.kit_rounds[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)

  const resumeId = inFlightBriefId(lead)
  const [trackedId, setTrackedId] = useState<string | null>(resumeId)
  useEffect(() => {
    if (resumeId) setTrackedId(resumeId)
  }, [resumeId])

  const onSettled = useCallback(
    (a: AgentActionDetail) => {
      if (a.status === 'done') setShown(a.id)
      onChanged()
    },
    [onChanged],
  )
  const { action: tracked, unavailable, retry } = useActionPoll(baseUrl, trackedId, onSettled)

  // The 20 s leads poll may still say in-flight for an action this poll has
  // already seen finish — trust the fresher read.
  const trackedDone = tracked != null && !isActionInFlight(tracked.status)
  const summaryInFlight = !!lead.actions?.in_flight && !(trackedDone && tracked?.id === resumeId)
  const inFlight = summaryInFlight || (tracked != null && isActionInFlight(tracked.status)) || busy
  const blocked = enqueueBlockedReason(meta)
  const disabled = inFlight || blocked != null

  const kinds = LEAD_ACTION_KINDS.filter((k) => k !== 'build_interview_kit' || lead.application_id != null)

  const submit = async (kind: LeadActionKind): Promise<void> => {
    if (takesNote(kind) && note.length > meta.note_max_chars) {
      setError(`The note is too long — at most ${meta.note_max_chars} characters.`)
      return
    }
    setBusy(true)
    setError(null)
    const trimmed = takesNote(kind) ? note.trim() : ''
    const out = await postAdminAction(baseUrl, {
      action: 'enqueue',
      kind,
      lead_id: lead.id,
      ...(trimmed ? { note: trimmed } : {}),
      ...(kind === 'build_interview_kit' ? { round } : {}),
    })
    setBusy(false)
    if (out.kind === 'queued') {
      setForm(null)
      setNote('')
      setShown(null)
      setTrackedId(out.action_id)
      onChanged()
      return
    }
    setError(agentActionRefusalMessage(out))
    const joined = refusalActionId(out)
    if (joined) setTrackedId(joined)
  }

  // Newest per kind, for the results line (the followed action shows live).
  const latest = lead.actions?.latest ?? {}
  const history = LEAD_ACTION_KINDS.flatMap((k) => {
    const b = latest[k]
    return b && b.id !== trackedId ? [{ kind: k, brief: b }] : []
  })

  return (
    <>
      {kinds.map((k) => (
        <button
          key={k}
          type="button"
          data-testid={`agent-action-open-${k}`}
          disabled={disabled}
          aria-expanded={form === k}
          title={blocked ?? (inFlight ? 'An agent action for this lead is already queued or running' : undefined)}
          onClick={() => {
            setError(null)
            setForm(form === k ? null : k)
          }}
          className={BUTTON}
        >
          {ACTION_LABEL[k]}
        </button>
      ))}
      <div data-testid="agent-actions" className="flex basis-full flex-col gap-2">
        {blocked ? (
          <p data-testid="agent-actions-blocked" className="font-mono text-[11px] text-muted-foreground">
            {blocked}
          </p>
        ) : null}
        {form && !disabled ? (
          <div data-testid="agent-action-form" className="flex max-w-2xl flex-wrap items-center gap-2">
            {form === 'build_interview_kit' ? (
              <>
                <label
                  htmlFor={`agent-action-round-${lead.id}`}
                  className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  round
                </label>
                <select
                  id={`agent-action-round-${lead.id}`}
                  data-testid="agent-action-round"
                  value={round}
                  onChange={(e) => setRound(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {meta.kit_rounds.map((r) => (
                    <option key={r} value={r}>
                      {roundLabel(r)}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            {takesNote(form) ? (
              <input
                data-testid="agent-action-note"
                aria-label={`Note for ${ACTION_LABEL[form]} (optional)`}
                value={note}
                maxLength={meta.note_max_chars}
                onChange={(e) => setNote(e.target.value)}
                placeholder={NOTE_HINT[form]}
                className="min-w-[16rem] flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ) : null}
            <button
              type="button"
              data-testid="agent-action-submit"
              disabled={busy || (form === 'build_interview_kit' && !round)}
              onClick={() => void submit(form)}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {busy ? 'Queueing…' : `Start: ${ACTION_LABEL[form]}`}
            </button>
            <button type="button" data-testid="agent-action-cancel" onClick={() => setForm(null)} className={BUTTON}>
              Cancel
            </button>
          </div>
        ) : null}
        {error ? (
          <p data-testid="agent-action-error" role="alert" className="font-mono text-[11px] text-destructive">
            {error}
          </p>
        ) : null}
        {unavailable ? <PollUnavailable onRetry={retry} testId="agent-action-unavailable" /> : null}
        {tracked ? (
          <div className="flex flex-col gap-2">
            <ActionStatus action={tracked} />
            {tracked.status !== 'queued' && tracked.status !== 'running' && shown === tracked.id ? (
              <AgentActionResult action={tracked} authuser={meta.compose_authuser} />
            ) : null}
            {tracked.status === 'done' && shown !== tracked.id ? (
              <button
                type="button"
                data-testid="agent-action-show"
                onClick={() => setShown(tracked.id)}
                className={cn(BUTTON, 'self-start')}
              >
                Show result
              </button>
            ) : null}
          </div>
        ) : null}
        {history.length > 0 ? (
          <ul data-testid="agent-action-history" className="flex flex-col gap-1">
            {history.map(({ kind, brief }) => (
              <li key={brief.id} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                  <span className="text-foreground">{ACTION_LABEL[kind]}</span>
                  <span className={STATUS_TONE[brief.status]}>{brief.status}</span>
                  <span className="text-muted-foreground">{fmtWhen(brief.completed_at ?? brief.created_at)}</span>
                  {brief.has_result ? (
                    <button
                      type="button"
                      data-testid={`agent-action-history-show-${kind}`}
                      aria-expanded={shown === brief.id}
                      onClick={() => setShown(shown === brief.id ? null : brief.id)}
                      className="text-accent-cool hover:underline"
                    >
                      {shown === brief.id ? 'hide result' : 'show result'}
                    </button>
                  ) : null}
                </span>
                {shown === brief.id ? (
                  <ResultLoader baseUrl={baseUrl} id={brief.id} authuser={meta.compose_authuser} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  )
}

// ── Run now ─────────────────────────────────────────────────────────────────

function RunNowButton({
  series,
  meta,
  baseUrl,
  onChanged,
}: {
  series: RunNowSeries
  meta: AgentActionsMeta
  baseUrl: string
  onChanged: () => void
}) {
  const state = meta.run_now[series]
  const [trackedId, setTrackedId] = useState<string | null>(state?.in_flight_action_id ?? null)
  const resumeId = state?.in_flight_action_id ?? null
  useEffect(() => {
    if (resumeId) setTrackedId(resumeId)
  }, [resumeId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { action, unavailable, retry } = useActionPoll(baseUrl, trackedId, onChanged)

  const running = busy || (action != null ? isActionInFlight(action.status) : resumeId != null)
  const blocked = enqueueBlockedReason(meta)
  const guarded = state?.guarded === true
  const title =
    blocked ??
    (guarded
      ? `The scheduled ${SERIES_LABEL[series]} is due ${fmtWhen(state?.next_scheduled_at ?? null)} — within ${meta.guard_minutes} minutes`
      : state?.next_scheduled_at
        ? `Next scheduled ${fmtWhen(state.next_scheduled_at)}`
        : undefined)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const out = await postAdminAction(baseUrl, { action: 'run_now', series })
    setBusy(false)
    if (out.kind === 'queued') {
      setTrackedId(out.action_id)
      onChanged()
      return
    }
    setError(agentActionRefusalMessage(out))
    const joined = refusalActionId(out)
    if (joined) setTrackedId(joined)
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid={`agent-run-now-${series}`}
        disabled={running || guarded || blocked != null}
        onClick={() => void run()}
        title={title}
        className={BUTTON}
      >
        {busy ? 'Queueing…' : `Run ${SERIES_LABEL[series]} now`}
      </button>
      {action ? (
        <span
          data-testid={`agent-run-now-status-${series}`}
          data-status={action.status}
          className={cn('font-mono text-[10px]', STATUS_TONE[action.status])}
        >
          {statusText(action)}
        </span>
      ) : null}
      {unavailable ? <PollUnavailable onRetry={retry} testId={`agent-run-now-unavailable-${series}`} /> : null}
      {error ? (
        <span
          data-testid={`agent-run-now-error-${series}`}
          role="alert"
          className="font-mono text-[10px] text-destructive"
        >
          {error}
        </span>
      ) : null}
    </span>
  )
}

/** The global Run now buttons, beside the Leads header actions. */
export function RunNowControls({
  meta,
  baseUrl,
  onChanged,
}: {
  meta: AgentActionsMeta
  baseUrl: string
  onChanged: () => void
}) {
  return (
    <>
      {RUN_NOW_SERIES.filter((s) => meta.run_now?.[s] != null).map((s) => (
        <RunNowButton key={s} series={s} meta={meta} baseUrl={baseUrl} onChanged={onChanged} />
      ))}
    </>
  )
}

// ── Recent agent actions ────────────────────────────────────────────────────

function actionRowLabel(r: Pick<AgentActionRow, 'kind' | 'series'>): string {
  if (r.kind !== 'run_now') return ACTION_LABEL[r.kind]
  return r.series ? `Run ${SERIES_LABEL[r.series]} now` : 'Run now'
}

/**
 * Every action, newest first — the way back to a result whose lead was deleted
 * (and to a Run now's outcome). Loaded when opened, not on every leads poll.
 */
export function RecentAgentActions({ baseUrl, authuser }: { baseUrl: string; authuser: string | null }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<AgentActionRow[] | null | 'error'>(null)
  const [shown, setShown] = useState<string | null>(null)

  const load = useCallback(async () => {
    const out = await fetchAdminActions(baseUrl)
    setRows(out ? out.actions : 'error')
  }, [baseUrl])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <details
      data-testid="agent-actions-recent"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="text-[12px]"
    >
      <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        Recent agent actions
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        {rows === null ? (
          <p className="font-mono text-[11px] text-muted-foreground">Loading…</p>
        ) : rows === 'error' ? (
          <p data-testid="agent-actions-recent-error" className="font-mono text-[11px] text-destructive">
            The list could not be loaded.
          </p>
        ) : rows.length === 0 ? (
          <p data-testid="agent-actions-recent-empty" className="font-mono text-[11px] text-muted-foreground">
            No agent actions yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((r) => (
              <li key={r.id} data-testid="agent-actions-recent-row" className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                  <span className="text-foreground">{actionRowLabel(r)}</span>
                  {r.company ? (
                    <span className="text-muted-foreground">
                      {r.company}
                      {r.title ? ` — ${r.title}` : ''}
                    </span>
                  ) : null}
                  {r.kind !== 'run_now' && r.lead_id == null ? (
                    <span data-testid="agent-actions-recent-deleted" className="text-amber-400">
                      lead deleted
                    </span>
                  ) : null}
                  <span className={STATUS_TONE[r.status]}>{r.status}</span>
                  <span className="text-muted-foreground">{fmtWhen(r.completed_at ?? r.created_at)}</span>
                  {r.has_result || r.status === 'failed' ? (
                    <button
                      type="button"
                      data-testid="agent-actions-recent-show"
                      aria-expanded={shown === r.id}
                      onClick={() => setShown(shown === r.id ? null : r.id)}
                      className="text-accent-cool hover:underline"
                    >
                      {shown === r.id ? 'hide' : r.has_result ? 'show result' : 'why'}
                    </button>
                  ) : null}
                </span>
                {shown === r.id ? <ResultLoader baseUrl={baseUrl} id={r.id} authuser={authuser} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
