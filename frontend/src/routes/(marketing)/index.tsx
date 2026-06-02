import { createFileRoute } from '@tanstack/react-router'

import { LiveIndicator } from '~/components/LiveIndicator'
import { LiveTicker } from '~/components/LiveTicker'
import { Button } from '~/components/ui/button'
import { useActivityStream } from '~/lib/use-activity-stream'

export const Route = createFileRoute('/(marketing)/')({
  component: Home,
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function Home() {
  const { events, status, count } = useActivityStream(API_BASE)

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center px-6 py-20">
      {/*
        Hero (SSR-static; PORTAL §5.1 Viewport 1). The name / title / tagline /
        contact are placeholders per PORTAL §12 (content variables TBD) — wired
        from candidate_profile in a later sub-milestone. Static markup so the
        hero renders with JS disabled (PORTAL §10); only the ticker hydrates.
      */}
      <section className="flex w-full max-w-xl flex-col items-center text-center">
        <div className="mb-6 flex items-center gap-4 text-sm">
          <span className="inline-flex items-center gap-1.5 text-foreground">🟢 Open to offers</span>
          <LiveIndicator status={status} count={count} />
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Jane Doe</h1>
        <p className="mt-2 text-lg text-muted-foreground">Senior Software Engineer · AI Systems</p>

        <p className="mt-6 text-balance text-base leading-relaxed text-foreground/90">
          I built this site. Everything moving on this page is the agent system I designed running my actual job search,
          right now.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild>
            <a href="#live-ticker">See it work →</a>
          </Button>
          <Button asChild variant="outline">
            {/* Rewired to /contact when that route lands (Phase 6.x). */}
            <a href="mailto:hello@example.com">Talk to me →</a>
          </Button>
        </div>
      </section>

      <LiveTicker events={events} status={status} />
    </main>
  )
}
