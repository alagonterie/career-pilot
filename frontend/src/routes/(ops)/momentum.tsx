import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { DetailPanel } from '~/components/funnel/DetailPanel'
import { FunnelBoard, FunnelBoardSkeleton } from '~/components/funnel/FunnelBoard'
import { StatTiles } from '~/components/funnel/StatTiles'
import { StateNote } from '~/components/states'
import { seo } from '~/lib/seo'
import { useFunnel, type FunnelApplication } from '~/lib/use-funnel'

// The funnel race detail (PORTAL §5.4). Visitor-facing name = "Momentum" / the
// `/momentum` route (the gamified horse-race framing); everything internal stays
// "funnel" (the `Funnel*` components, `useFunnel`, `/api/funnel`). `(ops)` is a
// pathless group → the URL is `/momentum`.
export const Route = createFileRoute('/(ops)/momentum')({
  component: MomentumPage,
  head: () =>
    seo({
      title: 'Momentum — Jane Doe',
      description: 'The job search in motion — every application, obfuscated by default, tracked stage by stage.',
      path: '/momentum',
    }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function MomentumPage() {
  const { data, status } = useFunnel(API_BASE)
  const [selected, setSelected] = React.useState<FunnelApplication | null>(null)
  const apps = data?.applications ?? []

  return (
    <>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-12">
        <header>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Momentum</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The job search in motion — every application moving stage by stage toward an offer, obfuscated by default.
          </p>
        </header>

        <StatTiles apps={apps} loading={status === 'loading'} />

        {/* The three async states share one visual language (§24.36 36.1) with a
            stable footprint (Tier-2): a shaped skeleton (board-height) while
            loading, and empty/error centered in a reserved region the same height
            as the board lanes — so flipping states never collapses the page. */}
        {status === 'loading' ? (
          <FunnelBoardSkeleton />
        ) : status === 'error' ? (
          <div className="flex min-h-[16rem] items-center justify-center">
            <StateNote data-testid="funnel-error" tone="error">
              The board is offline — retrying…
            </StateNote>
          </div>
        ) : apps.length === 0 ? (
          <div className="flex min-h-[16rem] items-center justify-center">
            <StateNote data-testid="funnel-empty">
              No applications in the search yet — the first agents are warming up.
            </StateNote>
          </div>
        ) : (
          <FunnelBoard apps={apps} onSelect={setSelected} />
        )}

        <footer className="border-t border-border pt-6 text-[11px] leading-relaxed text-muted-foreground">
          State changes are detected from Gmail (recruiter replies, scheduling) and Google Calendar (interview events).
          All companies obfuscated by default; revealed only post-close with the company&apos;s awareness.
        </footer>
      </main>

      <DetailPanel app={selected} onClose={() => setSelected(null)} />
    </>
  )
}
