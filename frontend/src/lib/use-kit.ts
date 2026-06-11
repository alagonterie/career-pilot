import * as React from 'react'

/**
 * One-shot fetch of a kit's public projection (§24.65 — `GET /api/kit`).
 * NOT polled: a kit is static once built (the host re-projects it server-side
 * on policy flips; a page reload picks that up). Sealed sections arrive as
 * `kind: 'withheld'` with a count + caption — the withheld TEXT never reaches
 * the wire, so everything this hook holds is safe by construction.
 */
export interface KitSection {
  id: string
  title: string
  part: number
  kind: 'content' | 'withheld'
  body?: string
  item_count?: number
  withheld_reason?: string
}

export interface KitPayload {
  application_ref: string
  public_state: string
  role_title: string | null
  round: string
  interview_type: string
  interview_at: string | null
  status: string
  sections: KitSection[]
}

export type KitStatus = 'loading' | 'ready' | 'missing' | 'error'

export interface KitState {
  data: KitPayload | null
  status: KitStatus
}

export function useKit(baseUrl: string, app: string | undefined, round: string | undefined): KitState {
  const [state, setState] = React.useState<KitState>({ data: null, status: 'loading' })

  React.useEffect(() => {
    if (!app || !round) {
      setState({ data: null, status: 'missing' })
      return
    }
    const ctrl = new AbortController()
    setState({ data: null, status: 'loading' })
    fetch(`${baseUrl}/api/kit?app=${encodeURIComponent(app)}&round=${encodeURIComponent(round)}`, {
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (res.status === 404 || res.status === 400) {
          setState({ data: null, status: 'missing' })
          return
        }
        if (!res.ok) throw new Error(`kit fetch ${res.status}`)
        const data = (await res.json()) as KitPayload
        setState({ data, status: 'ready' })
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return
        setState({ data: null, status: 'error' })
      })
    return () => ctrl.abort()
  }, [baseUrl, app, round])

  return state
}

const ROUND_LABELS: Record<string, string> = {
  SCREENING: 'Recruiter screen',
  TECH_SCREEN: 'Technical screen',
  SYS_DESIGN: 'System design',
  FINAL: 'Final round',
}

/** Visitor-facing label for a kit round ('TECH_SCREEN' → 'Technical screen'). */
export function roundLabel(round: string): string {
  return ROUND_LABELS[round.toUpperCase()] ?? round.toLowerCase().replace(/_/g, ' ')
}

/** Short display date for interview_at ('Jun 18'); '' when TBD. */
export function kitDate(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
