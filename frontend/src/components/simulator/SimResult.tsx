import * as React from 'react'

import { Button } from '~/components/ui/button'
import { renderMarkdownish } from '~/lib/markdownish'
import type { SimTraceEvent } from '~/lib/use-simulator-run'

import { SimActivity } from './SimActivity'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

/**
 * The shared post-run results presentation (§24.72) — used by BOTH the live
 * `/simulator` done-state and the `/simulator/results/:id` share page, so the
 * two stay in parity. The tailored résumé is the GIFT: a hero card with an
 * in-browser PDF preview + download. Everything else the run produced (the
 * résumé bullets + cold-outreach email, and the run activity) is tucked into
 * collapsed, expandable sections so the résumé stays the star. When the run
 * produced no tailored résumé the pitch opens by default (nothing to upstage it).
 */
interface SimResultProps {
  runId: string
  company: string | null
  role: string | null
  /** The bullets + outreach text — ALREADY stripped of the tailored-résumé JSON
   *  block (the share copy is stripped server-side; the live copy via the
   *  frontend `stripTailoredResumeBlock`). */
  outputText: string
  trace: SimTraceEvent[]
  costUsd: number | null
  hasTailoredResume: boolean
}

function CollapsibleSection({
  title,
  testid,
  defaultOpen = false,
  children,
}: {
  title: string
  testid: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <div data-testid={testid}>
      {/* The toggle is wrapped in an <h2> (the accessible disclosure pattern) so
          the section is a real heading — keeps heading order valid above the
          markdownish ## (h3) content, with the page h1 → h2 section → h3 body. */}
      <h2>
        <button
          type="button"
          data-testid={`${testid}-toggle`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          {title}
        </button>
      </h2>
      {open ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

export function SimResult({ runId, company, role, outputText, trace, costUsd, hasTailoredResume }: SimResultProps) {
  const pdfUrl = `${API_BASE}/api/simulator/results/${encodeURIComponent(runId)}/resume.pdf`
  return (
    <div data-testid="sim-result" className="flex flex-col gap-6">
      {hasTailoredResume ? (
        <div data-testid="sim-gift" className="rounded-xl border border-accent-cool/40 bg-accent-cool/5 px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-cool">Your tailored résumé</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">
            A full résumé, aimed at {role ?? 'your role'}
            {company ? ` @ ${company}` : ''}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Auto-tailored from my real experience for this exact role — preview it below, then download or forward it.
          </p>
          {/* In-browser preview of the EXACT PDF you'll download (served inline). */}
          <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
            <iframe
              src={pdfUrl}
              title="Tailored résumé preview"
              data-testid="sim-resume-preview"
              className="h-[30rem] w-full"
            />
          </div>
          <div className="mt-4">
            <Button asChild size="lg">
              <a href={pdfUrl} download data-testid="sim-download-resume">
                Download tailored résumé (PDF) ↓
              </a>
            </Button>
          </div>
        </div>
      ) : null}

      <CollapsibleSection
        testid="result-pitch"
        title="Résumé pitch + cold-outreach email"
        defaultOpen={!hasTailoredResume}
      >
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          {outputText.length > 0 ? (
            <div data-testid="sim-output-body">{renderMarkdownish(outputText)}</div>
          ) : (
            <p data-testid="sim-output-empty" className="text-sm text-muted-foreground">
              No output.
            </p>
          )}
        </div>
      </CollapsibleSection>

      {trace.length > 0 ? (
        <CollapsibleSection testid="result-activity" title={`See how this run worked (${trace.length} steps)`}>
          <SimActivity trace={trace} status="done" cost_usd={costUsd} />
        </CollapsibleSection>
      ) : null}
    </div>
  )
}
