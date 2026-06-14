import { createFileRoute, Link } from '@tanstack/react-router'

import { FunnelCompact } from '~/components/live/FunnelCompact'
import { LiveIndicator } from '~/components/LiveIndicator'
import { LiveTicker } from '~/components/LiveTicker'
import { Button } from '~/components/ui/button'
import { getWorkProfile } from '~/lib/profile-loader'
import { heroStats } from '~/lib/hero-stats'
import { seo } from '~/lib/seo'
import { useActivityStream } from '~/lib/use-activity-stream'
import { useFunnel } from '~/lib/use-funnel'
import { useTelemetry } from '~/lib/use-telemetry'
import { workProfile } from '~/lib/work-profile'

export const Route = createFileRoute('/(marketing)/')({
  component: Home,
  // SSR loader (§24.71 / 9.4b-1): the hero name/title + teasers render from the
  // live candidate_profile, falling back to the typed placeholder.
  loader: () => getWorkProfile(),
  head: ({ loaderData }) =>
    seo({ title: `${(loaderData?.profile ?? workProfile).name} — an AI agent runs my job search, live` }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function Home() {
  // Exclude turns: this 5-row teaser shows actions, not the per-turn cost seals
  // (those are the /live story) — so a stretch of turns can't blank the ticker.
  const { events, status, count } = useActivityStream(API_BASE, { exclude: ['turn'] })
  const { data: funnel, status: funnelStatus } = useFunnel(API_BASE)
  const { data: telemetry } = useTelemetry(API_BASE)
  const apps = funnel?.applications ?? []
  // Honest hero stat line (PORTAL §5.1 Viewport 1): real numbers from the live
  // hooks, each omitted when empty. Replaces the spec's cryptic "cache hit rate"
  // with "agent actions in 24h" (§24.71 hero audit).
  const stats = heroStats({ apps, events, actionsIn24h: telemetry?.local.activity_events_24h ?? null })
  // SSR-resolved candidate profile (placeholder fallback). De-`Jane Doe`s the hero.
  const { profile, identity } = Route.useLoaderData()
  const p = profile ?? workProfile

  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-6 py-20">
      {/*
        Viewport 1 — hero (PORTAL §5.1). Name/title SSR'd from candidate_profile
        (placeholder fallback). The hook orients first (what this is) before the
        live indicator + stat line prove it — kills the "what am I looking at?"
        landing (§24.71 hero audit). The two CTAs: "See it work" crosses into the
        ops register (/live, the hub); "Talk to me" → the conversion sink (/contact).
      */}
      <section className="flex w-full max-w-xl flex-col items-center text-center">
        <div className="mb-6 flex items-center gap-4 text-sm">
          <span className="inline-flex items-center gap-1.5 text-foreground">🟢 Open to offers</span>
          <LiveIndicator status={status} count={count} />
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{p.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{p.title}</p>

        <p className="mt-6 text-balance text-base leading-relaxed text-foreground/90">
          I built an AI agent system that runs my job search — and this entire page is it, working live.
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

        {/* Honest live stat line (PORTAL §5.1 Viewport 1) — the first-paint "this
            is real, right now" proof under the CTAs. Reserves a line of height so
            populating it (client-only hooks) doesn't shove the hero (§24.36). */}
        <p className="mt-6 min-h-5 font-mono text-xs text-muted-foreground" aria-live="polite">
          {stats.length > 0 ? stats.join('  ·  ') : null}
        </p>
      </section>

      {/* Viewport 2 — funnel strip (PORTAL §5.1): the search as a live pipeline,
          reusing the compact funnel; clicking through opens /pipeline. Rendered
          from first paint (skeleton while the first poll lands) so it holds its
          space instead of popping in — there's essentially always live data here.
          A cold backend error is the one case it collapses (no stranded skeleton). */}
      {funnelStatus !== 'error' ? (
        <section aria-labelledby="home-funnel-heading" className="mt-24 w-full">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="home-funnel-heading" className="text-sm font-semibold text-muted-foreground">
              The search, live
            </h2>
            <Link to="/pipeline" className="font-mono text-xs text-accent-cool hover:underline">
              track the search →
            </Link>
          </div>
          <FunnelCompact apps={apps} loading={funnelStatus === 'loading'} />
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
            {p.skills.slice(0, 5).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Recent work</h3>
          <ul className="flex flex-col gap-1 text-sm text-foreground/90">
            {p.projects.slice(0, 2).map((proj) => (
              <li key={proj.name} className="truncate">
                {proj.name}
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
          {identity.email ? (
            <a href={`mailto:${identity.email}`} className="text-sm text-accent-cool hover:underline">
              {identity.email}
            </a>
          ) : null}
        </div>
      </section>
    </main>
  )
}
