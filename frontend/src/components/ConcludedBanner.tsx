import { Link } from '@tanstack/react-router'

import type { PipelineApplication } from '~/lib/use-pipeline'

/**
 * The accepted-role company for the retrospective banner (§24.149 L2 / D4): the
 * offer-stage application's display ref, anonymized exactly like everywhere else —
 * a bracketed handle unless that application is public (revealed post-close with
 * the company's awareness). Null when no offer row is present (the banner then
 * stays generic — "I accepted an offer", no company named). Pure + testable.
 */
export function pickAcceptedCompany(apps: PipelineApplication[]): string | null {
  const offer = apps.find((a) => a.stage === 'offer')
  if (!offer) return null
  return offer.public_state === 'public' ? offer.application_ref : `[${offer.application_ref}]`
}

/**
 * The concluded-search retrospective banner (§24.149 L2 / D3) — shown atop `/` and
 * `/pipeline` ONLY when the owner has flipped `site_lifecycle_state` to `concluded`
 * from /admin. A calm, understated "the search is over" header in the brand accent;
 * the accepted company stays anonymized (D4) until separately revealed. Additive —
 * the evergreen showcase and the live simulator are unchanged.
 */
export function ConcludedBanner({
  apps,
  showPipelineLink = false,
}: {
  apps: PipelineApplication[]
  showPipelineLink?: boolean
}) {
  const company = pickAcceptedCompany(apps)
  return (
    <section
      data-testid="concluded-banner"
      aria-label="Search concluded"
      className="flex w-full flex-col items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-6 py-5 text-center"
    >
      <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-primary">
        <span aria-hidden="true">◆</span> Search concluded
      </p>
      <p className="text-balance text-base font-medium text-foreground">
        I accepted an offer
        {company ? (
          <>
            {' '}
            at <span className="font-semibold">{company}</span>
          </>
        ) : null}
        .
      </p>
      <p className="max-w-xl text-balance text-sm leading-relaxed text-muted-foreground">
        The agent ran the whole search — sourcing roles, tailoring my résumé, drafting outreach, and prepping interviews
        — start to finish. What you see below is how it went.
      </p>
      {showPipelineLink ? (
        <Link to="/pipeline" className="mt-1 font-mono text-xs text-accent-cool hover:underline">
          See the full pipeline →
        </Link>
      ) : null}
    </section>
  )
}
