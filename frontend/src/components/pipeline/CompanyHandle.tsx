import type { ReactNode } from 'react'

import type { PipelineApplication } from '~/lib/use-pipeline'
import { cn } from '~/lib/utils'

/**
 * The application's company identifier, rendered in the site's one anonymization
 * language (§24.137). While a hiring process is live the company shows as a
 * stable pseudonymous *handle* — as the same muted, ring-bordered chip the
 * §24.134d company-tier redaction uses on /kit and in the agent traces. So a
 * visitor reads `infra-e` as a deliberate privacy handle, not a rendering bug
 * (the old raw `[infra-e]` brackets looked broken). On reveal
 * (`public_state === 'public'`) the real name shows plainly, inheriting the
 * caller's type styling.
 */

/**
 * The canonical anonymization sentence (§24.137) — the ONE voice for "this
 * company shows as a stable handle while its hiring process is live." Exported
 * (§24.171) so the agent-trace refs on `/` + `/dashboard` (and the Recent-outcomes
 * handle) reuse it verbatim instead of inventing a second phrasing.
 */
export const ANON_HANDLE_TITLE = 'Company anonymized — a stable handle kept while this hiring process is live.'

/**
 * The same sentence for a company ref that is ALSO a deep-link into the /pipeline
 * drawer (§24.60 / §24.171): the trace-stream refs and the Recent-outcomes rows.
 * Carries both the "what is this handle" explanation and the "what happens on
 * click" affordance the owner asked for, in one hover.
 */
export const COMPANY_REF_LINK_TITLE = `${ANON_HANDLE_TITLE} Opens this application in the pipeline.`

// Shared so the chip and its legend can never drift. Matches the company tier in
// `Redaction.tsx` (muted fill, inset ring); `text-[0.92em]` sits the pill a touch
// below the surrounding label so it reads as a tag, not a shout.
export const ANON_HANDLE_CHIP =
  'inline-flex max-w-full items-center rounded bg-muted px-1.5 align-baseline font-mono text-[0.92em] leading-snug text-muted-foreground ring-1 ring-inset ring-border'

/**
 * The shared anonymization chip (§24.153) — the ONE presentational component
 * behind every "company shown as a stable handle" pill: the live board (via
 * `CompanyHandle`), the legend sample, and the `/about` explainer. Carries the
 * chip styling + the explanatory `title` + `cursor-help`; the canonical
 * `company-handle` testid is opt-in (`testId`) so illustrative uses (legend,
 * /about) don't inflate the board's chip count.
 */
export function HandleChip({ label, testId, className }: { label: ReactNode; testId?: string; className?: string }) {
  return (
    <span data-testid={testId} title={ANON_HANDLE_TITLE} className={cn(ANON_HANDLE_CHIP, 'cursor-help', className)}>
      {label}
    </span>
  )
}

export function CompanyHandle({ app }: { app: PipelineApplication }) {
  if (app.public_state === 'public') return <>{app.application_ref}</>
  return <HandleChip label={app.application_ref} testId="company-handle" />
}

/**
 * A once-per-page legend that turns the anonymized handles from "what's that?"
 * into a legible privacy feature — the pipeline twin of `RedactionLegend`
 * (§24.134d), and styled to match it: a bordered, titled key, not a loose run of
 * text (§24.147). The sample handle is a generic placeholder, never a real
 * identifier.
 */
export function CompanyHandleLegend() {
  return (
    <div
      data-testid="company-handle-legend"
      className="flex max-w-xl flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5"
    >
      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/80">
        Company handles
      </span>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <HandleChip label="infra-e" /> a company shown as a stable handle while its hiring process is live — the real
        name appears once it closes.
      </p>
    </div>
  )
}
