import { createFileRoute, Link } from '@tanstack/react-router'

import { FunnelCompact } from '~/components/live/FunnelCompact'
import { LiveTicker } from '~/components/LiveTicker'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { getHeroSeed } from '~/lib/hero-seed-loader'
import { getWorkProfile } from '~/lib/profile-loader'
import { heroStats, relativeAgo } from '~/lib/hero-stats'
import { seo } from '~/lib/seo'
import { useActivityStream } from '~/lib/use-activity-stream'
import { useFunnel } from '~/lib/use-funnel'
import { useTelemetry } from '~/lib/use-telemetry'
import { workProfile } from '~/lib/work-profile'

export const Route = createFileRoute('/(marketing)/')({
  component: Home,
  // SSR loader (§24.71 / 9.4b-1): the hero name/title + teasers render from the
  // live candidate_profile (placeholder fallback). The polish pass adds the hero
  // stat SEED — the whole stat line (the two counts + "last activity X ago")
  // rendered into the SSR HTML so nothing pops in from a skeleton; the live hooks
  // take over after mount.
  loader: async () => {
    const [profilePayload, heroSeed] = await Promise.all([getWorkProfile(), getHeroSeed()])
    return { ...profilePayload, heroSeed }
  },
  head: ({ loaderData }) =>
    seo({ title: `${(loaderData?.profile ?? workProfile).name} — an AI agent runs my job search, live` }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function Home() {
  // Exclude turns: this 5-row teaser shows actions, not the per-turn cost seals
  // (those are the /live story) — so a stretch of turns can't blank the ticker.
  const { events, status, count } = useActivityStream(API_BASE, { exclude: ['turn'] })
  const { data: funnel, status: funnelStatus } = useFunnel(API_BASE)
  const { data: telemetry, status: telemetryStatus } = useTelemetry(API_BASE)
  const apps = funnel?.applications ?? []
  // SSR-resolved candidate profile (placeholder fallback) + the hero stat SEED
  // (the whole line, pre-rendered server-side). De-`Jane Doe`s the hero.
  const { profile, identity, heroSeed } = Route.useLoaderData()
  // The hero stat line (PORTAL §5.1 Viewport 1), assembled so it's fully SSR'd and
  // never shifts on the live takeover:
  //   - counts: the two SSR-able segments. Show the live values once the polls
  //     settle, else the SSR'd seed (identical on hydration).
  //   - last activity: the live stream's latest non-turn event once it arrives,
  //     else the seed STRING (server-computed, so hydration matches — the client
  //     doesn't recompute the relative time until the stream supplies the SAME
  //     event, so the takeover is a no-op width-wise).
  const statsReady = funnelStatus !== 'loading' && telemetryStatus !== 'loading'
  const liveCounts = heroStats({ apps, events: [], actionsIn24h: telemetry?.local.activity_events_24h ?? null })
  const counts = statsReady ? liveCounts : heroSeed.counts
  const liveLastActivity = events.length > 0 ? `last activity ${relativeAgo(events[events.length - 1].ts)}` : null
  const lastActivity = liveLastActivity ?? heroSeed.lastActivity
  const shownStats = [...counts, lastActivity].filter((s): s is string => Boolean(s))
  const p = profile ?? workProfile

  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-6 py-16">
      {/*
        Viewport 1 — hero (PORTAL §5.1). Name/title SSR'd from candidate_profile
        (placeholder fallback). The hook orients first (what this is) before the
        live indicator + stat line prove it — kills the "what am I looking at?"
        landing (§24.71 hero audit). The two CTAs: "See it work" crosses into the
        ops register (/live, the hub); "Talk to me" → the conversion sink (/contact).
      */}
      <section className="flex w-full max-w-xl flex-col items-center text-center">
        {/* One intentional availability badge (PORTAL §5.1 / the / polish pass).
            "Open to offers" is the signal a recruiter actually wants; the brand-green
            dot pulses while the live feed is connected (the page's own liveness) and
            falls still if it drops — replacing the literal 🟢 emoji + a second
            competing live indicator with a single, on-brand pill. */}
        <div className="mb-6 flex justify-center">
          <span
            data-testid="hero-status"
            data-status={status}
            title={status === 'open' ? `live — ${count} event${count === 1 ? '' : 's'} received` : status}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3.5 py-1.5 text-sm text-foreground"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${status === 'open' ? 'bg-primary cp-live-pulse' : 'bg-muted-foreground'}`}
            />
            Open to offers
          </span>
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{p.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{p.title}</p>

        <p className="mt-6 text-balance text-base leading-relaxed text-foreground/90">
          I built an <strong className="font-semibold text-foreground">AI agent system</strong> that runs my job search
          — and this entire page is it, working live.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild>
            {/* The one cross-register CTA (PORTAL §3.5): opens the /live dashboard. */}
            <Link to="/dashboard">See it work →</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/contact" search={{ from: 'home' }}>
              Talk to me →
            </Link>
          </Button>
        </div>

        {/* Honest stat line (PORTAL §5.1 Viewport 1) — the first-paint "this is
            real, right now" proof under the CTAs. The WHOLE line is SSR-seeded
            (counts + "last activity X ago"), so nothing pops in; the live hooks
            take over the same values after mount, so there's no shift. The fixed
            height (1 line desktop / 2 lines mobile) + the skeleton are only for the
            rare empty-seed case (backend unreachable at SSR) — §24.36 + the / pass. */}
        <div
          data-testid="hero-stats"
          className="mt-6 flex h-9 flex-wrap items-center justify-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground sm:h-5"
          aria-live="polite"
        >
          {shownStats.length > 0 ? (
            <p className="text-balance">{shownStats.join('  ·  ')}</p>
          ) : (
            <>
              <Skeleton className="h-3 w-28 rounded-full" />
              <Skeleton className="h-3 w-32 rounded-full" />
              <Skeleton className="h-3 w-24 rounded-full" />
            </>
          )}
        </div>
      </section>

      {/* Viewport 1.5 — the pitch (PORTAL §5.1 / §24.75). The hero hooks; the live
          viewports below prove. This beat is the one place the system is *explained*
          in plain English — value-first, the candidate's voice — before the evidence
          arrives, so a visitor isn't left reverse-engineering what's happening. Static
          prose (no per-visitor data); ends with one quiet deepener into the full story
          (/about). The less-interested scroll straight past into the proof below. */}
      <section aria-labelledby="home-pitch-heading" className="mt-16 w-full max-w-xl text-center">
        <h2 id="home-pitch-heading" className="sr-only">
          What this is
        </h2>
        <p className="text-balance text-base leading-relaxed text-foreground/90">
          The job hunt is a grind — find the roles, research each company, tailor your résumé, write the outreach, prep
          for the interview, then do it again a hundred times. So I built an AI agent system that runs that loop for me,
          continuously, and keeps me in the driver’s seat.
        </p>
        {/* The loop as four confident steps — centered + wrapping (not a left-aligned
            2-col grid that hitched against the centered prose), each with a small
            brand-tinted number chip instead of a footnote-sized grey digit. */}
        <ol className="mx-auto mt-7 flex max-w-xl flex-wrap items-center justify-center gap-x-4 gap-y-3 text-sm text-foreground/90">
          {['finds roles', 'tailors my résumé', 'drafts outreach', 'builds interview prep'].map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-balance text-sm leading-relaxed text-muted-foreground">
          …and you can watch it happen below, or run it on your own open role right now.
        </p>
        <Link to="/about" className="mt-5 inline-block text-sm text-accent-cool hover:underline">
          Read the full story →
        </Link>
      </section>

      {/* Viewport 2 — funnel strip (PORTAL §5.1): the search as a live pipeline,
          reusing the compact funnel; clicking through opens /pipeline. Rendered
          from first paint (skeleton while the first poll lands) so it holds its
          space instead of popping in — there's essentially always live data here.
          A cold backend error is the one case it collapses (no stranded skeleton). */}
      {funnelStatus !== 'error' ? (
        <section aria-labelledby="home-funnel-heading" className="mt-20 w-full">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="home-funnel-heading" className="text-sm font-semibold text-muted-foreground">
              My job search, live
            </h2>
            <Link to="/pipeline" className="font-mono text-xs text-accent-cool hover:underline">
              track it →
            </Link>
          </div>
          <FunnelCompact apps={apps} loading={funnelStatus === 'loading'} />
          <p className="mt-3 text-[11px] text-muted-foreground">
            Companies are obfuscated until each process closes — a deliberate privacy choice.
          </p>
        </section>
      ) : null}

      {/* Viewport 3 — agent-activity hook. The "see it all →" link is the
          contextual bridge into the ops register (PORTAL §5.1 / §24.35 Pass A). */}
      <LiveTicker
        events={events}
        status={status}
        action={
          <Link to="/dashboard" className="font-mono text-xs text-accent-cool hover:underline">
            see it all →
          </Link>
        }
      />

      {/* Viewport 4 — the "watch me apply" pitch (PORTAL §5.1): a single high-intent
          CTA into the grippiest spoke. No form here — the form lives on /simulator. */}
      <section aria-labelledby="home-sim-heading" className="mt-20 w-full text-center">
        <h2 id="home-sim-heading" className="text-2xl font-bold tracking-tight">
          Watch me apply to your role
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-balance text-sm leading-relaxed text-muted-foreground">
          Name your company and a role you’re hiring for. The same agent stack runs right in your browser — researching
          it, tailoring my résumé, and drafting outreach — then hands you both the tailored résumé and the cold-email
          draft. Nothing gets sent or submitted anywhere.
        </p>
        <div className="mt-6 flex justify-center">
          <Button asChild size="lg">
            <Link to="/watch">Run it on your role →</Link>
          </Button>
        </div>
      </section>

      {/* Viewport 5 — resume + contact teaser (PORTAL §5.1). */}
      <section aria-labelledby="home-teaser-heading" className="mt-20 grid w-full gap-10 sm:grid-cols-3">
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
          <Link to="/experience" className="mt-1 font-mono text-xs text-accent-cool hover:underline">
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
