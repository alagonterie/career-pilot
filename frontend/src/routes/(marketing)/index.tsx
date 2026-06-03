import { createFileRoute, Link } from '@tanstack/react-router'

import { FunnelCompact } from '~/components/live/FunnelCompact'
import { LiveIndicator } from '~/components/LiveIndicator'
import { LiveTicker } from '~/components/LiveTicker'
import { Button } from '~/components/ui/button'
import { useActivityStream } from '~/lib/use-activity-stream'
import { useFunnel } from '~/lib/use-funnel'
import { workProfile } from '~/lib/work-profile'

export const Route = createFileRoute('/(marketing)/')({
  component: Home,
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function Home() {
  const { events, status, count } = useActivityStream(API_BASE)
  const { data: funnel } = useFunnel(API_BASE)
  const apps = funnel?.applications ?? []

  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-6 py-20">
      {/*
        Viewport 1 — hero (SSR-static; PORTAL §5.1). Generic placeholder persona
        (Jane Doe); real content arrives via candidate_profile later. The two
        CTAs: "See it work" crosses into the ops register (/live, the hub);
        "Talk to me" goes to the conversion sink (/contact).
      */}
      <section className="flex w-full max-w-xl flex-col items-center text-center">
        <div className="mb-6 flex items-center gap-4 text-sm">
          <span className="inline-flex items-center gap-1.5 text-foreground">🟢 Open to offers</span>
          <LiveIndicator status={status} count={count} />
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Jane Doe</h1>
        <p className="mt-2 text-lg text-muted-foreground">Senior Software Engineer · AI Systems, DevX</p>

        <p className="mt-6 text-balance text-base leading-relaxed text-foreground/90">
          I built this site. Everything moving on this page is the agent system I designed running my actual job search,
          right now.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild>
            {/* The one cross-register CTA (PORTAL §3.5): opens the /live dashboard. */}
            <Link to="/live">See it work →</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/contact" search={{ from: 'home' }}>
              Talk to me →
            </Link>
          </Button>
        </div>
      </section>

      {/* Viewport 2 — funnel strip (PORTAL §5.1): the search as a live pipeline,
          reusing the compact funnel; clicking through opens /funnel. */}
      {apps.length > 0 ? (
        <section aria-labelledby="home-funnel-heading" className="mt-24 w-full">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="home-funnel-heading" className="text-sm font-semibold text-muted-foreground">
              The search, live
            </h2>
            <Link to="/funnel" className="font-mono text-xs text-accent-cool hover:underline">
              see the funnel →
            </Link>
          </div>
          <FunnelCompact apps={apps} />
          <p className="mt-3 text-[11px] text-muted-foreground">
            Companies are obfuscated until each process closes — a deliberate privacy choice.
          </p>
        </section>
      ) : null}

      {/* Viewport 3 — live activity hook. The "watch live →" link is the
          contextual bridge into the ops register (PORTAL §5.1 / §24.35 Pass A). */}
      <LiveTicker
        events={events}
        status={status}
        action={
          <Link to="/live" className="font-mono text-xs text-accent-cool hover:underline">
            watch live →
          </Link>
        }
      />

      {/* Viewport 4 — simulator pitch (PORTAL §5.1): a single high-intent CTA into
          the grippiest spoke. No form here — the form lives on /simulator. */}
      <section aria-labelledby="home-sim-heading" className="mt-24 w-full text-center">
        <h2 id="home-sim-heading" className="text-2xl font-bold tracking-tight">
          See it work on your role
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-balance text-sm leading-relaxed text-muted-foreground">
          Type your company and a role. The same agent stack runs live in your browser — researching, tailoring a
          resume, and drafting outreach in ~30 seconds. Nothing is saved.
        </p>
        <div className="mt-6 flex justify-center">
          <Button asChild size="lg">
            <Link to="/simulator">Try the simulator →</Link>
          </Button>
        </div>
      </section>

      {/* Viewport 5 — resume + contact teaser (PORTAL §5.1). */}
      <section aria-labelledby="home-teaser-heading" className="mt-24 grid w-full gap-10 sm:grid-cols-3">
        <h2 id="home-teaser-heading" className="sr-only">
          More about me
        </h2>
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Skills</h3>
          <ul className="flex flex-col gap-1 text-sm text-foreground/90">
            {workProfile.skills.slice(0, 5).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Recent work</h3>
          <ul className="flex flex-col gap-1 text-sm text-foreground/90">
            {workProfile.projects.slice(0, 2).map((p) => (
              <li key={p.name} className="truncate">
                {p.name}
              </li>
            ))}
          </ul>
          <Link to="/work" className="mt-1 font-mono text-xs text-accent-cool hover:underline">
            see all →
          </Link>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Talk to me</h3>
          <Link to="/contact" search={{ from: 'home' }} className="text-sm text-accent-cool hover:underline">
            Contact form →
          </Link>
          <a href="mailto:hello@example.com" className="text-sm text-accent-cool hover:underline">
            hello@example.com
          </a>
        </div>
      </section>
    </main>
  )
}
