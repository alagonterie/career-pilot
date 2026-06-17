import { createFileRoute } from '@tanstack/react-router'
import { AnimatePresence } from 'motion/react'
import * as React from 'react'

import { ArchDiagram } from '~/components/architecture/ArchDiagram'
import { Legend, ModeBanner } from '~/components/architecture/ModeBanner'
import { NodePanel } from '~/components/architecture/NodePanel'
import { deriveNodeStatus, NODES, type ArchNode } from '~/components/architecture/nodes'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { seo } from '~/lib/seo'
import { PERSON_NAME, REPO_URL, repoBlob } from '~/lib/site'
import { useArchitecture } from '~/lib/use-architecture'
import { useObservability } from '~/lib/use-observability'

// Second page of the ops register (PORTAL §5.5). `(ops)` is pathless → the URL
// is still `/architecture`. The shared ops layout/header stays deferred until
// `/live` (7.3) makes a third ops page.
export const Route = createFileRoute('/(ops)/architecture')({
  component: ArchitecturePage,
  head: () =>
    seo({
      title: `Architecture — ${PERSON_NAME}`,
      description: 'Live system map of the agent — host, container, and the sanitized public path, with real status.',
      path: '/architecture',
    }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function ArchitecturePage() {
  const { arch, mode, status } = useArchitecture(API_BASE)
  // Provider health + session topology for the integration nodes (§24.69). A
  // separate poll — the diagram already renders from `arch`; obs enriches it.
  const { data: observability } = useObservability(API_BASE)
  const [selected, setSelected] = React.useState<ArchNode | null>(null)

  return (
    <>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Architecture</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The real running system — triggers, the host, the per-session container, and the sanitized path that feeds
              this page. <span className="sm:hidden">Tap</span>
              <span className="hidden sm:inline">Click</span> any node for detail.
            </p>
          </div>
          <ModeBanner mode={mode} loading={status === 'loading'} />
          <Legend />
        </header>

        {status === 'loading' ? (
          // Loading twin of the diagram (§24.36 36.1, Tier-2 stability) — the
          // skeleton matches the diagram's aspect ratio (ArchDiagram uses the
          // same 760×736 box), so it reserves the exact footprint and loading→ok
          // is ≈zero layout shift.
          <Skeleton data-testid="arch-skeleton" className="aspect-[760/736] w-full rounded-lg" />
        ) : status === 'error' ? (
          // Reserved region (not a bare-line collapse), but not the diagram's full
          // ~900px height (that would be a large void) — a comfortable framed area.
          <div className="flex min-h-[16rem] items-center justify-center">
            <StateNote data-testid="arch-empty" tone="error">
              System status is offline — retrying…
            </StateNote>
          </div>
        ) : arch ? (
          <ArchDiagram
            arch={arch}
            mode={mode}
            obs={observability}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        ) : (
          <div className="flex min-h-[16rem] items-center justify-center">
            <StateNote data-testid="arch-empty">Reading system status…</StateNote>
          </div>
        )}

        <section
          aria-labelledby="arch-explainer-heading"
          className="flex flex-col gap-3 border-t border-border pt-6 text-sm leading-relaxed text-muted-foreground"
        >
          <h2 id="arch-explainer-heading" className="font-mono text-xs uppercase tracking-widest text-foreground">
            What you&apos;re looking at
          </h2>
          <p>
            A clone-and-customize fork of NanoClaw: a long-running Node host orchestrates per-session Bun containers,
            each running the Claude Agent SDK. Every action is mirrored through a sanitization pipeline into append-only
            public tables — the only data this page can read. Status badges are honest: a node is colored only when
            something real is probed; the rest is drawn as structure.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-accent-cool">
            <button
              type="button"
              onClick={() => setSelected(NODES.find((n) => n.id === 'pub-sanitize') ?? null)}
              className="text-accent-cool hover:underline"
            >
              see the sanitizer run →
            </button>
            <a href={repoBlob('README.md')} target="_blank" rel="noreferrer" className="hover:underline">
              README ↗
            </a>
            <a href={repoBlob('CLAUDE.md')} target="_blank" rel="noreferrer" className="hover:underline">
              CLAUDE.md ↗
            </a>
            <a
              href={`${REPO_URL}/tree/master/groups/career-pilot/.claude/agents-src`}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              agent definitions ↗
            </a>
            <a href={`${REPO_URL}/fork`} target="_blank" rel="noreferrer" className="hover:underline">
              fork the repo ↗
            </a>
          </div>
        </section>
      </main>

      <AnimatePresence>
        {selected ? (
          <NodePanel
            key={selected.id}
            node={selected}
            status={deriveNodeStatus(selected, arch, mode, observability)}
            arch={arch}
            mode={mode}
            obs={observability}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </AnimatePresence>
    </>
  )
}
