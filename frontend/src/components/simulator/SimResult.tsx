import * as React from 'react'

import { Button } from '~/components/ui/button'
import { renderMarkdownish } from '~/lib/markdownish'
import { parseOutreach } from '~/lib/parse-outreach'
import type { SimTraceEvent } from '~/lib/use-simulator-run'

import { SimActivity } from './SimActivity'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

/**
 * The shared post-run results presentation (§24.72) — used by BOTH the live
 * `/simulator` done-state and the `/simulator/results/:id` share page, so they
 * stay in parity. The run ends in TWO gifts of equal weight: the tailored résumé
 * (a downloadable PDF, previewable in a modal) and a personalized cold-outreach
 * email (sneak-peeked, expandable). The behind-the-scenes agent activity sits
 * below in a collapsed section. The résumé prose is intentionally not shown — the
 * PDF is the artifact.
 */
interface SimResultProps {
  runId: string
  company: string | null
  role: string | null
  /** The run output (résumé prose + outreach email) — already stripped of the
   *  tailored-résumé JSON block. The cold-outreach email is parsed out of it. */
  outputText: string
  trace: SimTraceEvent[]
  costUsd: number | null
  hasTailoredResume: boolean
}

/** GIFT 1 — the tailored résumé: download + an in-modal PDF preview (native
 *  <dialog>: focus-trap + Escape + backdrop for free, no deps). */
function ResumeGift({ runId, company, role }: { runId: string; company: string | null; role: string | null }) {
  const pdfUrl = `${API_BASE}/api/simulator/results/${encodeURIComponent(runId)}/resume.pdf`
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  return (
    <div data-testid="sim-gift" className="rounded-xl border border-accent-cool/40 bg-accent-cool/5 px-6 py-5">
      <p className="font-mono text-xs uppercase tracking-widest text-accent-cool">Your tailored résumé</p>
      <h2 className="mt-1 text-lg font-semibold tracking-tight">
        A full résumé, aimed at {role ?? 'your role'}
        {company ? ` @ ${company}` : ''}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Auto-tailored from my real experience for this exact role — yours to download and forward.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <a href={pdfUrl} download data-testid="sim-download-resume">
            Download résumé (PDF) ↓
          </a>
        </Button>
        <Button
          variant="outline"
          size="lg"
          data-testid="sim-resume-preview-open"
          onClick={() => dialogRef.current?.showModal()}
        >
          Preview
        </Button>
      </div>
      <dialog
        ref={dialogRef}
        data-testid="sim-resume-preview"
        className="m-auto w-[92vw] max-w-3xl rounded-xl border border-border bg-background p-0 shadow-xl backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Tailored résumé preview
          </span>
          <button
            type="button"
            aria-label="Close preview"
            onClick={() => dialogRef.current?.close()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <iframe src={pdfUrl} title="Tailored résumé preview" className="h-[78vh] w-full" />
      </dialog>
    </div>
  )
}

/** GIFT 2 — the cold-outreach email: subject + a 2-line sneak peek to invite the
 *  click, expanding to the full email. Same gift styling as the résumé. */
function OutreachGift({ subject, body }: { subject: string; body: string }) {
  const [open, setOpen] = React.useState(false)
  const peek = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
  return (
    <div data-testid="sim-outreach" className="rounded-xl border border-accent-cool/40 bg-accent-cool/5 px-6 py-5">
      <p className="font-mono text-xs uppercase tracking-widest text-accent-cool">My cold-outreach email to you</p>
      {/* Honest framing (§24.72): the email is a sample DRAFT, not a verified
          document like the résumé — in the real flow the agent writes it into a
          Gmail draft for human review before anything sends. */}
      <p className="mt-1 text-xs text-muted-foreground">
        A sample draft — in my real search my agent writes these into a Gmail draft for me to review before I send.
      </p>
      {subject ? <p className="mt-2 text-sm font-semibold text-foreground">Subject: {subject}</p> : null}
      {open ? (
        <div data-testid="sim-outreach-body" className="mt-2 text-sm leading-relaxed">
          {renderMarkdownish(body)}
        </div>
      ) : (
        <>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{peek}</p>
          <button
            type="button"
            data-testid="sim-outreach-expand"
            onClick={() => setOpen(true)}
            className="mt-3 inline-flex items-center gap-2 font-mono text-xs text-accent-cool transition-colors hover:underline"
          >
            <span aria-hidden="true">▸</span> Read the full email
          </button>
        </>
      )}
    </div>
  )
}

function ActivitySection({ trace, costUsd }: { trace: SimTraceEvent[]; costUsd: number | null }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div data-testid="result-activity">
      <button
        type="button"
        data-testid="result-activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        See how my agents worked ({trace.length} steps)
      </button>
      {open ? (
        <div className="mt-3">
          <SimActivity trace={trace} status="done" cost_usd={costUsd} />
        </div>
      ) : null}
    </div>
  )
}

export function SimResult({ runId, company, role, outputText, trace, costUsd, hasTailoredResume }: SimResultProps) {
  const outreach = parseOutreach(outputText)
  return (
    <div data-testid="sim-result" className="flex flex-col gap-6">
      {hasTailoredResume ? <ResumeGift runId={runId} company={company} role={role} /> : null}

      {outreach ? (
        <OutreachGift subject={outreach.subject} body={outreach.body} />
      ) : outputText.trim().length > 0 ? (
        // No recognizable outreach section — show the raw output rather than nothing.
        <div data-testid="sim-outreach" className="rounded-xl border border-border bg-card px-5 py-4">
          <div data-testid="sim-output-body" className="text-sm leading-relaxed">
            {renderMarkdownish(outputText)}
          </div>
        </div>
      ) : null}

      {trace.length > 0 ? <ActivitySection trace={trace} costUsd={costUsd} /> : null}
    </div>
  )
}
