import { createFileRoute, useRouter } from '@tanstack/react-router'
import * as React from 'react'

import { ConcludedBanner } from '~/components/ConcludedBanner'
import { CompanyHandleLegend } from '~/components/pipeline/CompanyHandle'
import { DetailPanel } from '~/components/pipeline/DetailPanel'
import { PipelineBoard, PipelineBoardSkeleton, PipelineOffboardSkeleton } from '~/components/pipeline/PipelineBoard'
import { StatTiles } from '~/components/pipeline/StatTiles'
import { StateNote } from '~/components/states'
import { seo } from '~/lib/seo'
import { PERSON_NAME } from '~/lib/site'
import { useSiteLifecycle } from '~/lib/use-lifecycle'
import { usePipeline, type PipelineApplication } from '~/lib/use-pipeline'

// The pipeline race detail (PORTAL §5.4). Visitor-facing name = "My Job Pipeline" /
// the `/pipeline` route (§24.59 — supersedes "Momentum"; `/momentum` redirects
// here). §24.77 D3 retired the "pipeline" naming everywhere visitor-facing (the
// components are `Pipeline*`, the hook `usePipeline`); only the internal
// `/api/pipeline` fetch URL keeps its name. `(ops)` is a pathless group → the URL
// is `/pipeline`.
export const Route = createFileRoute('/(ops)/pipeline')({
  component: PipelinePage,
  // Drawer deep-link (§24.57): `?app=«application_ref»` opens that card's
  // DetailPanel once the pipeline loads. Anything non-string is dropped.
  validateSearch: (search: Record<string, unknown>): { app?: string } => ({
    app: typeof search.app === 'string' && search.app.length > 0 ? search.app : undefined,
  }),
  head: () =>
    seo({
      title: `My Job Pipeline — ${PERSON_NAME}`,
      description: 'The job search in motion — every application, obfuscated by default, tracked stage by stage.',
      path: '/pipeline',
    }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function PipelinePage() {
  const { data, status } = usePipeline(API_BASE)
  const apps = data?.applications ?? []
  // §24.149 L2: the concluded-search retrospective, owner-flipped from /admin.
  const lifecycle = useSiteLifecycle(data)
  const { app: appParam } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()

  // The URL is the drawer's single source of truth (§24.58 Δ): the drawer is
  // open iff `?app=«ref»` resolves to an application (unknown ref = no drawer;
  // deep links work with no extra wiring; back/forward just work — and there is
  // no local-state/param race to guard, which is what the §24.57 consume-once
  // hack existed for).
  const selected: PipelineApplication | null = React.useMemo(
    () => (appParam ? (apps.find((a) => a.application_ref === appParam) ?? null) : null),
    [apps, appParam],
  )

  // A card tap PUSHES the param so the OS back gesture dismisses the drawer in
  // place (the ingrained mobile overlay habit) instead of leaving the page.
  // `resetScroll: false` on every drawer navigation — the router scrolls to top
  // by default, which threw the visitor back to the top of the board on close.
  const pushedRef = React.useRef(false)
  const select = (app: PipelineApplication): void => {
    pushedRef.current = true
    void navigate({ search: { app: app.application_ref }, resetScroll: false })
  }
  // Explicit close (Esc / backdrop / button): pop the entry we pushed so
  // history doesn't accumulate; a direct deep-link arrival (no in-app entry to
  // pop) clears via replace so back still exits the site correctly.
  const close = (): void => {
    if (pushedRef.current) {
      pushedRef.current = false
      router.history.back()
    } else {
      void navigate({ search: {}, replace: true, resetScroll: false })
    }
  }

  return (
    <>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-12">
        {lifecycle === 'concluded' ? <ConcludedBanner apps={apps} /> : null}
        <header className="flex flex-col gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">My Job Pipeline</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The job search in motion — every application moving stage by stage toward an offer, obfuscated by default.
            </p>
          </div>
          {/* §24.137: decode the anonymized handles before a visitor clicks a card
              — the chip + one line turns `[infra-e]` from "looks broken" into a
              legible privacy choice (mirrors the /kit RedactionLegend). §24.149 L1:
              hidden ONLY in the settled-empty (cold-start) state — there are no
              handles to explain yet, so the legend would be premature; kept during
              loading (the board skeleton holds the space), on a transient error (the
              board had cards and will again), and whenever there are apps. */}
          {status === 'loading' || status === 'error' || apps.length > 0 ? <CompanyHandleLegend /> : null}
        </header>

        <StatTiles apps={apps} loading={status === 'loading'} />

        {/* The three async states share one visual language (§24.36 36.1) with a
            stable footprint (Tier-2): a shaped skeleton (board-height) while
            loading, and empty/error centered in a reserved region the same height
            as the board lanes — so flipping states never collapses the page. */}
        {status === 'loading' ? (
          <>
            <PipelineBoardSkeleton />
            <PipelineOffboardSkeleton />
          </>
        ) : status === 'error' ? (
          <div className="flex min-h-[16rem] items-center justify-center">
            <StateNote data-testid="pipeline-error" tone="error">
              The board is offline — retrying…
            </StateNote>
          </div>
        ) : apps.length === 0 ? (
          <div className="flex min-h-[16rem] items-center justify-center">
            <StateNote data-testid="pipeline-empty">
              No applications in the search yet — the first agents are warming up.
            </StateNote>
          </div>
        ) : (
          <PipelineBoard apps={apps} onSelect={select} />
        )}

        <footer className="border-t border-border pt-6 text-[11px] leading-relaxed text-muted-foreground">
          State changes are detected from Gmail (recruiter replies, scheduling) and Google Calendar (interview events).
          All companies obfuscated by default; revealed only post-close with the company&apos;s awareness.
        </footer>
      </main>

      <DetailPanel app={selected} onClose={close} />
    </>
  )
}
