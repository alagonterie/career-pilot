/**
 * Server-Sent Events client for the portal activity stream.
 *
 * Uses a `fetch`-with-stream-reader transport, NOT `EventSource` (PORTAL §3.5
 * locked rule #4: custom headers + HTTP/2 multiplex, sidestepping the browser
 * 6-connection cap). The wire format mirrors the host broadcaster
 * (src/modules/portal/sse-broadcaster.ts): `id: <seq>\ndata: <json>\n\n`
 * frames + `: ka\n\n` keepalives. Resume is by the monotonic `seq` carried in
 * `id:` (PORTAL §8.3) — reconnect with `?since=<lastSeq>` for exactly-once
 * delivery across the Cloudflare Tunnel idle timeout.
 *
 * The frame parser (`SseParser`) is split out as a pure, synchronous unit so
 * it is testable without a network or DOM; the connect loop is exercised by
 * the dual-server Playwright E2E.
 */

export interface SseEvent {
  id?: string
  event?: string
  data: string
}

/**
 * Incremental SSE frame parser. Feed it decoded text chunks (which may split
 * mid-frame); it buffers across calls and returns the complete events found so
 * far. Handles multi-line `data:`, `id:`, `event:`, CRLF, and skips `:`
 * comment/keepalive lines.
 */
export class SseParser {
  private buffer = ''

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const events: SseEvent[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const ev = parseFrame(frame)
      if (ev) events.push(ev)
    }
    return events
  }
}

/** Parse one SSE frame (no trailing blank line). Returns null for comment-only
 * frames (keepalives) and otherwise an event with joined multi-line data. */
export function parseFrame(frame: string): SseEvent | null {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue // blank or comment (`: ka`)
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1) // SSE: strip one leading space
    switch (field) {
      case 'id':
        id = value
        break
      case 'event':
        event = value
        break
      case 'data':
        data.push(value)
        break
      default:
        break
    }
  }

  if (data.length === 0 && id === undefined && event === undefined) return null
  return { id, event, data: data.join('\n') }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting'

export interface ActivityStreamOptions {
  /** Portal API origin, e.g. `http://localhost:3001`. */
  baseUrl: string
  /** Resume cursor (`seq`); `0` (default) replays the full backlog then goes live. */
  since?: number
  /** Mock-only async-state override (§24.36) — `loading`/`empty`/`error`; honored
   * only by the dev/E2E API. Forwarded as `?__state`; absent in production. */
  stateParam?: 'loading' | 'empty' | 'error'
  signal: AbortSignal
  onEvent: (event: SseEvent) => void
  onStatus?: (status: StreamStatus) => void
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 15_000

/**
 * Open `/api/activity/stream` and pump events to `onEvent` until `signal`
 * aborts. Reconnects with exponential backoff, resuming from the last seen
 * `seq` so no event is missed or duplicated across drops.
 */
export async function connectActivityStream(opts: ActivityStreamOptions): Promise<void> {
  let cursor = opts.since ?? 0
  let backoff = INITIAL_BACKOFF_MS
  let firstAttempt = true

  while (!opts.signal.aborted) {
    opts.onStatus?.(firstAttempt ? 'connecting' : 'reconnecting')
    try {
      const url =
        `${opts.baseUrl}/api/activity/stream?since=${cursor}` + (opts.stateParam ? `&__state=${opts.stateParam}` : '')
      const res = await fetch(url, {
        signal: opts.signal,
        headers: { Accept: 'text/event-stream' },
      })
      if (!res.ok || !res.body) throw new Error(`activity stream HTTP ${res.status}`)

      opts.onStatus?.('open')
      backoff = INITIAL_BACKOFF_MS
      firstAttempt = false

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.id && /^\d+$/.test(ev.id)) cursor = parseInt(ev.id, 10)
          opts.onEvent(ev)
        }
      }
    } catch {
      if (opts.signal.aborted) return
    }

    if (opts.signal.aborted) return
    firstAttempt = false
    await delay(backoff, opts.signal)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

export interface SimulatorStreamOptions {
  /** Portal API origin, e.g. `http://localhost:3001`. */
  baseUrl: string
  /** The run id returned by `POST /api/simulator`. */
  runId: string
  signal: AbortSignal
  onEvent: (event: SseEvent) => void
  onError?: (err: unknown) => void
  onClose?: () => void
}

/**
 * Open one simulator-run SSE stream (`/api/simulator/:id/stream`) and pump its
 * named `trace`/`chat`/`task` events to `onEvent` until the run ends or `signal`
 * aborts (Sub-milestone 8.2). Reuses the same fetch-stream-reader + `SseParser`
 * transport as `connectActivityStream`, but a run is *ephemeral*: the server
 * pushes live from connect with no `id:`/seq, so there is no backlog replay and
 * no reconnect — a drop ends the run (`onError`), a clean end fires `onClose`.
 */
export async function connectSimulatorStream(opts: SimulatorStreamOptions): Promise<void> {
  try {
    const url = `${opts.baseUrl}/api/simulator/${encodeURIComponent(opts.runId)}/stream`
    const res = await fetch(url, { signal: opts.signal, headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) throw new Error(`simulator stream HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) opts.onEvent(ev)
    }
    opts.onClose?.()
  } catch (err) {
    if (opts.signal.aborted) return
    opts.onError?.(err)
  }
}
