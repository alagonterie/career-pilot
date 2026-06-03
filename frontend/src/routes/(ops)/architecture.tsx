import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { ArchDiagram } from '~/components/architecture/ArchDiagram'
import { Legend, ModeBanner } from '~/components/architecture/ModeBanner'
import { NodePanel } from '~/components/architecture/NodePanel'
import { deriveNodeStatus, type ArchNode } from '~/components/architecture/nodes'
import { REPO_URL, repoBlob } from '~/lib/site'
import { useArchitecture } from '~/lib/use-architecture'

// Second page of the ops register (PORTAL §5.5). `(ops)` is pathless → the URL
// is still `/architecture`. The shared ops layout/header stays deferred until
// `/live` (7.3) makes a third ops page.
export const Route = createFileRoute('/(ops)/architecture')({
  component: ArchitecturePage,
  head: () => ({
    meta: [
      { title: 'Architecture — Jane Doe' },
      {
        name: 'description',
        content: 'Live system map of the agent — host, container, and the sanitized public path, with real status.',
      },
    ],
  }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function ArchitecturePage() {
  const { arch, mode, status } = useArchitecture(API_BASE)
  const [selected, setSelected] = React.useState<ArchNode | null>(null)

  return (
    <>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Architecture</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The real running system — triggers, the host, the per-session container, and the sanitized path that feeds
              this page. Click any node for detail.
            </p>
          </div>
          <ModeBanner mode={mode} />
          <Legend />
        </header>

        {arch ? (
          <ArchDiagram arch={arch} mode={mode} selectedId={selected?.id ?? null} onSelect={setSelected} />
        ) : (
          <p data-testid="arch-empty" className="font-mono text-sm text-muted-foreground">
            {status === 'error' ? 'System status is offline — retrying…' : 'Reading system status…'}
          </p>
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
            <a href={repoBlob('README.md')} target="_blank" rel="noreferrer" className="hover:underline">
              README ↗
            </a>
            <a href={repoBlob('CLAUDE.md')} target="_blank" rel="noreferrer" className="hover:underline">
              CLAUDE.md ↗
            </a>
            <a
              href={`${REPO_URL}/tree/master/groups/career-pilot/.claude/agents`}
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

      <NodePanel
        node={selected}
        status={selected ? deriveNodeStatus(selected, arch, mode) : 'structural'}
        arch={arch}
        mode={mode}
        onClose={() => setSelected(null)}
      />
    </>
  )
}
