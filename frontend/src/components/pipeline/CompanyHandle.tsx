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

const ANON_TITLE = 'Company anonymized — a stable handle kept while this hiring process is live.'

// Shared so the chip and its legend can never drift. Matches the company tier in
// `Redaction.tsx` (muted fill, inset ring); `text-[0.92em]` sits the pill a touch
// below the surrounding label so it reads as a tag, not a shout.
export const ANON_HANDLE_CHIP =
  'inline-flex max-w-full items-center rounded bg-muted px-1.5 align-baseline font-mono text-[0.92em] leading-snug text-muted-foreground ring-1 ring-inset ring-border'

export function CompanyHandle({ app }: { app: PipelineApplication }) {
  if (app.public_state === 'public') return <>{app.application_ref}</>
  return (
    <span data-testid="company-handle" title={ANON_TITLE} className={cn(ANON_HANDLE_CHIP, 'cursor-help')}>
      {app.application_ref}
    </span>
  )
}

/**
 * A once-per-page legend that turns the anonymized handles from "what's that?"
 * into a legible privacy feature — the pipeline twin of `RedactionLegend`
 * (§24.134d). The sample handle is a generic placeholder, never a real
 * identifier.
 */
export function CompanyHandleLegend() {
  return (
    <p
      data-testid="company-handle-legend"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed text-muted-foreground"
    >
      <span className={ANON_HANDLE_CHIP}>infra-e</span>
      <span>
        a company shown as a stable handle while its hiring process is live — the real name appears once it closes.
      </span>
    </p>
  )
}
