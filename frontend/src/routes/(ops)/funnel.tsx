import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { DetailPanel } from '~/components/funnel/DetailPanel'
import { FunnelBoard } from '~/components/funnel/FunnelBoard'
import { StatTiles } from '~/components/funnel/StatTiles'
import { useFunnel, type FunnelApplication } from '~/lib/use-funnel'

// First page of the ops register (PORTAL §5.4). `(ops)` is a pathless route
// group → the URL is still `/funnel`. A shared ops layout/header is deferred
// until more ops pages land (mirrors the deferred marketing-group layout).
export const Route = createFileRoute('/(ops)/funnel')({
  component: FunnelPage,
  head: () => ({
    meta: [
      { title: 'Funnel — Jane Doe' },
      {
        name: 'description',
        content: 'Live job-search pipeline — every application, obfuscated by default, tracked stage by stage.',
      },
    ],
  }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function FunnelPage() {
  const { data, status } = useFunnel(API_BASE)
  const [selected, setSelected] = React.useState<FunnelApplication | null>(null)
  const apps = data?.applications ?? []

  return (
    <>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-12">
        <header>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Funnel</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The job search as a live pipeline — every application, obfuscated by default.
          </p>
        </header>

        <StatTiles apps={apps} />

        {apps.length > 0 ? (
          <FunnelBoard apps={apps} onSelect={setSelected} />
        ) : (
          <p data-testid="funnel-empty" className="font-mono text-sm text-muted-foreground">
            {status === 'error' ? 'Funnel data is offline — retrying…' : 'Loading the pipeline…'}
          </p>
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
