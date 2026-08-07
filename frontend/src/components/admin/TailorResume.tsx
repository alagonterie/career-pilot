import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchTailoredRuns, startTailoredRun, tailoredPdfUrl, type TailoredRun } from '~/lib/use-admin'

/**
 * Per-lead résumé tailoring, inside the Leads detail disclosure (§24.191).
 *
 * Mounts only when a lead row is expanded, so the fetch is lazy by construction.
 * Generation is fire-and-poll: the server inserts a `pending` row as the lock and
 * returns immediately, so a double-click, a refresh, or a second tab cannot spend
 * twice — the second attempt gets a 409 and simply joins the poll.
 */
const POLL_MS = 2000
const MAX_JD = 12000
const MAX_NOTES = 1000

function fmtCost(cents: number | null): string {
  if (cents == null) return '—'
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** The honesty signal. `tailored` is the good case; both fallbacks mean the bio
 *  the model wrote was discarded and the master's generic summary is what will
 *  print — worth knowing before this goes to an employer. */
function BioOutcome({ outcome }: { outcome: TailoredRun['bio_outcome'] }) {
  if (!outcome) return null
  if (outcome === 'tailored') {
    return (
      <span data-testid="tailor-bio-tailored" className="font-mono text-[11px] text-primary">
        ✓ summary tailored
      </span>
    )
  }
  const why =
    outcome === 'fallback_stub'
      ? 'The model returned no usable summary, so your master summary is what prints.'
      : 'The summary cited a figure that appears nowhere in your master résumé, so it was discarded and your master summary is what prints.'
  return (
    <span data-testid="tailor-bio-fallback" className="font-mono text-[11px] text-amber-400" title={why}>
      ⚠ summary fell back to master
    </span>
  )
}

export function TailorResume({ leadId, baseUrl }: { leadId: string; baseUrl: string }) {
  const [runs, setRuns] = useState<TailoredRun[] | null>(null)
  const [open, setOpen] = useState(false)
  const [jd, setJd] = useState('')
  const [notes, setNotes] = useState('')
  const [attribute, setAttribute] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Poll only while a run is live; a bare interval would keep firing forever on
  // a page left open on an expanded row.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const latest = runs?.[0] ?? null
  const pending = latest?.status === 'pending'

  const load = useCallback(async () => {
    setRuns(await fetchTailoredRuns(baseUrl, leadId))
  }, [baseUrl, leadId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!pending) return
    timer.current = setTimeout(() => void load(), POLL_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [pending, runs, load])

  const generate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await startTailoredRun(baseUrl, leadId, {
      jd: jd.trim() || undefined,
      notes: notes.trim() || undefined,
      attribute,
    })
    setBusy(false)
    if (!res.ok && res.error !== 'already_generating') {
      setError(
        res.error === 'daily_cap_reached'
          ? "Today's tailoring cap is used up."
          : res.error === 'no_master_profile'
            ? 'No master résumé is composed yet.'
            : res.error === 'llm_unavailable'
              ? 'The model gateway is unavailable.'
              : (res.error ?? `failed (${res.status})`),
      )
      return
    }
    setOpen(false)
    setJd('')
    setNotes('')
    await load()
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3" data-testid="tailor-section">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">tailored résumé</span>

        {pending ? (
          <span data-testid="tailor-pending" className="font-mono text-[11px] text-muted-foreground">
            generating…
          </span>
        ) : latest?.status === 'ready' && latest.has_resume ? (
          <>
            <a
              data-testid="tailor-download"
              href={tailoredPdfUrl(baseUrl, latest.id)}
              className="font-mono text-[11px] text-accent-cool hover:underline"
            >
              download PDF ↓
            </a>
            <BioOutcome outcome={latest.bio_outcome} />
            <span className="font-mono text-[11px] text-muted-foreground">
              {fmtWhen(latest.created_at)} · {fmtCost(latest.cost_cents)}
            </span>
          </>
        ) : latest?.status === 'failed' ? (
          <span data-testid="tailor-failed" className="font-mono text-[11px] text-destructive">
            {latest.error ?? 'generation failed'}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">none yet</span>
        )}

        {!pending ? (
          <button
            type="button"
            data-testid="tailor-open"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? 'Cancel' : latest ? 'Regenerate' : 'Tailor résumé'}
          </button>
        ) : null}

        {runs && runs.length > 1 ? (
          <span className="font-mono text-[11px] text-muted-foreground">{runs.length} versions</span>
        ) : null}
      </div>

      {error ? (
        <p data-testid="tailor-error" className="font-mono text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      {open ? (
        <div className="flex max-w-2xl flex-col gap-2">
          {/* The stored description is least trustworthy exactly on the leads
              that reached us via a reposter (§24.190) — and at this moment the
              owner has the real posting open. So paste beats stored. */}
          <textarea
            data-testid="tailor-jd"
            value={jd}
            maxLength={MAX_JD}
            onChange={(e) => setJd(e.target.value)}
            rows={5}
            placeholder="Paste the real job description here. Leave blank to use the description we scraped."
            className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <input
            data-testid="tailor-notes"
            value={notes}
            maxLength={MAX_NOTES}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Emphasize… (optional)"
            className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              data-testid="tailor-attribute"
              checked={attribute}
              onChange={(e) => setAttribute(e.target.checked)}
            />
            attribute click-throughs from this résumé to this company
          </label>
          <div>
            <button
              type="button"
              data-testid="tailor-generate"
              disabled={busy}
              onClick={() => void generate()}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Generate'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
