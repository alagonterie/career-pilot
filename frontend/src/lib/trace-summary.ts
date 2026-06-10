import type { SimTraceEvent } from './use-simulator-run'

/**
 * Humanize a TraceEvent's raw `input_summary` — a (possibly truncated)
 * `JSON.stringify` of the tool input — into the salient, readable bit
 * (STRATEGY §24.31 Δ: the activity pane should read like /live, not a JSON
 * dump). The wire is unchanged; this is presentation-only. Truncated or
 * unparseable JSON falls back to best-effort field extraction, then to the
 * raw string.
 */

const MAX_LEN = 110

const FIELD_PRIORITY = ['description', 'query', 'url', 'prompt', 'command', 'file_path', 'path', 'role'] as const

/**
 * Is this trace row a subagent dispatch? `t:'subagent'` is the canonical wire
 * shape; `name:'Agent'|'Task'` covers traces persisted before the runner
 * mapped the SDK's delegation tool (named `Agent`) to `t:'subagent'`.
 */
export function isSubagentDispatch(ev: SimTraceEvent): boolean {
  return ev.t === 'subagent' || ev.name === 'Agent' || ev.name === 'Task'
}

/** The display label for a dispatch line — the subagent's name when it is one
 * (from the event, else dug out of the legacy input_summary). */
export function dispatchLabel(ev: SimTraceEvent): string {
  if (!isSubagentDispatch(ev)) return ev.name ?? 'tool'
  return ev.subagent ?? extractOne(ev.input_summary, 'subagent_type') ?? ev.name ?? 'subagent'
}

/** Pull one string field from a (possibly truncated) JSON summary. */
function extractOne(raw: string | undefined, key: string): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      const v = parsed[key]
      return typeof v === 'string' && v.trim() ? v.trim() : null
    }
  } catch {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
    if (m && m[1].trim()) return unescapeJson(m[1].trim())
  }
  return null
}

export function humanizeTraceSummary(ev: SimTraceEvent): string | null {
  const raw = ev.input_summary
  if (!raw || raw.trim().length === 0) return null

  const fields = extractFields(raw)

  if (isSubagentDispatch(ev)) {
    return cap(fields.description ?? fields.prompt ?? fallback(raw))
  }
  if (ev.name === 'WebSearch' && fields.query) return cap(`“${fields.query}”`)
  if (ev.name === 'WebFetch' && fields.url) return cap(shortUrl(fields.url))

  for (const key of FIELD_PRIORITY) {
    if (fields[key]) return cap(key === 'url' ? shortUrl(fields[key]!) : fields[key]!)
  }
  return cap(fallback(raw))
}

/** Pull the known fields out of the summary — JSON.parse when whole, a
 * truncation-tolerant regex sweep otherwise. */
function extractFields(raw: string): Partial<Record<(typeof FIELD_PRIORITY)[number], string>> {
  const out: Partial<Record<(typeof FIELD_PRIORITY)[number], string>> = {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      for (const key of FIELD_PRIORITY) {
        const v = parsed[key]
        if (typeof v === 'string' && v.trim()) out[key] = v.trim()
      }
      return out
    }
  } catch {
    // Truncated (the wire caps input_summary) — sweep for fields instead. The
    // value pattern tolerates a missing closing quote so a string cut mid-way
    // still yields its surviving prefix.
    for (const key of FIELD_PRIORITY) {
      const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
      if (m && m[1].trim()) out[key] = unescapeJson(m[1].trim())
    }
  }
  return out
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s.replace(/\\"/g, '"').replace(/\\n/g, ' ')
  }
}

/** Strip the protocol and trailing slash so URLs scan as destinations. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** Last resort: show the raw summary minus its JSON dressing. */
function fallback(raw: string): string {
  return raw
    .replace(/^[{\s"]+/, '')
    .replace(/[}\s"]+$/, '')
    .trim()
}

function cap(s: string): string {
  const t = s.trim()
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 1)}…` : t
}
