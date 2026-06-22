import { createFileRoute, Link } from '@tanstack/react-router'
import type { CSSProperties } from 'react'

import { AvailabilityBadge } from '~/components/AvailabilityBadge'
import { ConcludedBanner } from '~/components/ConcludedBanner'
import { InfoTip } from '~/components/InfoTip'
import { PipelineCompact } from '~/components/live/PipelineCompact'
import { LiveTicker } from '~/components/LiveTicker'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { getHeroSeed } from '~/lib/hero-seed-loader'
import { getWorkProfile } from '~/lib/profile-loader'
import { heroStats, heroStatPhase, relativeAgo } from '~/lib/hero-stats'
import { seo } from '~/lib/seo'
import { useActivityStream } from '~/lib/use-activity-stream'
import { useSiteLifecycle } from '~/lib/use-lifecycle'
import { usePipeline } from '~/lib/use-pipeline'
import { useReveal } from '~/lib/use-reveal'
import { useTelemetry } from '~/lib/use-telemetry'
import { workProfile } from '~/lib/work-profile'
import { cn } from '~/lib/utils'

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

// The hero stat line when the polls have settled but there's no activity to show
// yet — a cold launch or a freshly-reset pipeline (§24.149 L1 / D2). An honest,
// forward-looking freshness line in the same mono register as the live stats; it
// reads "fresh", never "broken", and deliberately makes no banner of being new.
const HERO_FRESH_LINE = 'the agent is warming up — first activity incoming'

function Home() {
  // Exclude turns: this 5-row teaser shows actions, not the per-turn cost seals
  // (those are the /live story) — so a stretch of turns can't blank the ticker.
  const { events, status, count } = useActivityStream(API_BASE, { exclude: ['turn'] })
  const { data: pipeline, status: pipelineStatus } = usePipeline(API_BASE)
  const { data: telemetry, status: telemetryStatus } = useTelemetry(API_BASE)
  const apps = pipeline?.applications ?? []
  // §24.149 L2: the concluded-search retrospective, owner-flipped from /admin.
  const lifecycle = useSiteLifecycle(pipeline)
  // SSR-resolved candidate profile (placeholder fallback) + the hero stat SEED
  // (the whole line, pre-rendered server-side). De-`Jane Doe`s the hero.
  const { profile, heroSeed } = Route.useLoaderData()
  // The hero stat line (PORTAL §5.1 Viewport 1), assembled so it's fully SSR'd and
  // never shifts on the live takeover:
  //   - counts: the two SSR-able segments. Show the live values once the polls
  //     settle, else the SSR'd seed (identical on hydration).
  //   - last activity: the live stream's latest non-turn event once it arrives,
  //     else the seed STRING (server-computed, so hydration matches — the client
  //     doesn't recompute the relative time until the stream supplies the SAME
  //     event, so the takeover is a no-op width-wise).
  const statsReady = pipelineStatus !== 'loading' && telemetryStatus !== 'loading'
  const liveCounts = heroStats({ apps, events: [], actionsIn24h: telemetry?.local.agent_actions_24h ?? null })
  const counts = statsReady ? liveCounts : heroSeed.counts
  const liveLastActivity = events.length > 0 ? `last activity ${relativeAgo(events[events.length - 1].ts)}` : null
  const lastActivity = liveLastActivity ?? heroSeed.lastActivity
  const shownStats = [...counts, lastActivity].filter((s): s is string => Boolean(s))
  // §24.149 L1: pick the stat-line treatment. Skeleton is for genuine first-load
  // ONLY — once both polls settle with nothing to show (cold launch), an honest
  // freshness line, not a perpetual skeleton. Both sources errored → collapse.
  const statsPhase = heroStatPhase({
    hasStats: shownStats.length > 0,
    ready: statsReady,
    offline: pipelineStatus === 'error' && telemetryStatus === 'error',
  })
  const p = profile ?? workProfile

  // Scroll reveal (the `/` scroll pass, §24.147): each below-the-fold beat
  // rises into place as it enters the viewport (transform-only, §24.135). One hook
  // per section (hooks run unconditionally — the pipeline ref simply never attaches
  // in its error branch).
  // Observed on the capability LIST, not the section: the section's top is the
  // intro paragraph, so observing it fired the cascade while the list was still
  // below the fold (items animated unseen). Observing the list aligns the trigger
  // with when the items are actually entering view (§24.147 fu fix).
  const pitchReveal = useReveal<HTMLOListElement>()
  const pipelineReveal = useReveal<HTMLElement>()
  const tickerReveal = useReveal<HTMLDivElement>()
  const watchReveal = useReveal<HTMLElement>()
  const teaserReveal = useReveal<HTMLElement>()

  return (
    <main className="relative mx-auto flex max-w-3xl flex-col items-center overflow-x-clip px-6 py-20 sm:py-24">
      {/* Ambient hero backdrop (the / flare pass) — faint brand-hue radial washes
          behind the hero for depth. Decorative + non-interactive, painted behind
          the in-flow content (-z-10); anchored to this relative <main>. `max-w-full`
          + the parent's `overflow-x-clip` keep it from ever exceeding the viewport
          (a wider value caused a phone-width horizontal scroll). */}
      <div
        aria-hidden="true"
        className="cp-aurora pointer-events-none absolute left-1/2 top-0 -z-10 h-[26rem] w-[44rem] max-w-full -translate-x-1/2"
      />
      {/* §24.149 L2: the concluded-search retrospective leads the page once the
          owner flips the lifecycle from /admin; otherwise nothing renders and the
          page is the normal live search. Client-resolved (post-mount), so it never
          diverges the SSR'd hero. */}
      {lifecycle === 'concluded' ? (
        <div className="mb-10 w-full max-w-xl">
          <ConcludedBanner apps={apps} showPipelineLink />
        </div>
      ) : null}
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
        {/* Hero entrance (the / flare pass): the entrance rides only on the LIVE
            chrome — the badge, the CTAs, and the stat line — which stagger in via
            CSS (`cp-rise`, no-JS- + reduced-motion-safe). The name/title/hook are
            left OUT of the animation on purpose: they're SSR'd for an instant solid
            first paint, and a fade from opacity:0 would undercut that. So the
            headline is solid the moment the HTML lands; the live bits animate around
            it. */}
        <div className="cp-rise mb-6 flex justify-center">
          <AvailabilityBadge
            status={status}
            concluded={lifecycle === 'concluded'}
            title={status === 'open' ? `live — ${count} event${count === 1 ? '' : 's'} received` : status}
            data-testid="hero-status"
          />
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{p.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{p.title}</p>

        <p className="mt-6 text-balance text-base leading-relaxed text-foreground/90">
          I built an <strong className="font-semibold text-foreground">AI agent system</strong> that runs my job search
          — and this entire page is it, working live.
        </p>

        <div
          className="cp-rise mt-8 flex flex-wrap items-center justify-center gap-3"
          style={{ animationDelay: '0.08s' }}
        >
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
            (counts + "searching since" + "last activity X ago"), so nothing pops in;
            the live hooks take over the same values after mount, so there's no shift.
            `min-h` (not a fixed height) reserves the space across all four phases
            (§24.149 L1): live `stats`, a first-load `skeleton`, the settled-empty
            `fresh` line (cold launch — never a perpetual skeleton), or a collapsed
            line on a hard outage (the badge carries that signal) — and lets the
            stats wrap gracefully to a second line when all four segments are present
            (§24.149 "searching since") rather than clipping a fixed height. */}
        <div
          data-testid="hero-stats"
          className="cp-rise mt-6 flex min-h-9 flex-wrap items-center justify-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground sm:min-h-5"
          style={{ animationDelay: '0.16s' }}
          aria-live="polite"
        >
          {statsPhase === 'stats' ? (
            // §24.153 item 2: each segment is its own `whitespace-nowrap` flex
            // child so the container's `flex flex-wrap` wraps *between* whole
            // segments (a phrase like "4 active job applications" never splits
            // mid-words), and the `·` separator is glued to the front of its
            // following segment so it can never orphan to a line start. The old
            // single `<p>{join('  ·  ')}</p>` defeated the flex-wrap (one child)
            // and word-wrapped instead.
            shownStats.map((seg, i) => (
              <span key={seg} className="whitespace-nowrap">
                {i > 0 ? (
                  <span aria-hidden="true" className="mr-2 select-none text-muted-foreground/50">
                    ·
                  </span>
                ) : null}
                {seg}
              </span>
            ))
          ) : statsPhase === 'loading' ? (
            <>
              <Skeleton className="h-3 w-28 rounded-full" />
              <Skeleton className="h-3 w-32 rounded-full" />
              <Skeleton className="h-3 w-24 rounded-full" />
            </>
          ) : statsPhase === 'fresh' ? (
            <p data-testid="hero-stats-fresh" className="text-balance">
              {HERO_FRESH_LINE}
            </p>
          ) : null}
        </div>
      </section>

      {/* Viewport 1.5 — the pitch (PORTAL §5.1 / §24.75). The hero hooks; the live
          viewports below prove. This beat is the one place the system is *explained*
          in plain English — value-first, the candidate's voice — before the evidence
          arrives, so a visitor isn't left reverse-engineering what's happening. Static
          prose (no per-visitor data); ends with one quiet deepener into the full story
          (/about). The less-interested scroll straight past into the proof below. */}
      <section aria-labelledby="home-pitch-heading" className="mt-24 w-full max-w-xl text-center">
        <h2 id="home-pitch-heading" className="sr-only">
          What this is
        </h2>
        <p className="text-balance text-base leading-relaxed text-foreground/90">
          The job hunt is a grind — find the roles, research each company, tailor your résumé, write the outreach, prep
          for the interview, then do it again a hundred times. So I built an AI agent system that runs that loop for me,
          continuously, and keeps me in the driver’s seat.
        </p>
        {/* §24.137 / §24.119: the four things the agent does, as a balanced 2-col
            set. A grid (not the old flex-wrap) so it never orphans — the §24.135
            "3 on a line, 4 alone" wrap is structurally impossible now. A uniform
            brand dot replaces the 1–4 numerals: the steps run organically, not in
            a fixed sequence, so an ordinal implied an order that isn't real. The
            fifth — "learns from every outcome", the §24.111 loop-closing
            meta-capability — spans both columns on its own line with a ↻ loop-back
            glyph, kept parallel + subject-less with the four verb phrases. */}
        {/* The list is the reveal element (cp-still: it triggers + carries the
            stagger, it doesn't itself rise) so its items cascade in as the list
            enters view, not while it's still below the fold (§24.147 fu). */}
        <ol
          ref={pitchReveal.ref}
          data-testid="home-pitch-list"
          className={cn(
            'mx-auto mt-7 grid w-fit grid-cols-2 gap-x-8 gap-y-3 text-left text-sm text-foreground/90 cp-still',
            pitchReveal.className,
          )}
        >
          {['finds roles', 'tailors my résumé', 'drafts outreach', 'builds interview prep'].map((step, i) => (
            <li
              key={step}
              className="cp-stagger-item flex items-center gap-2.5"
              style={{ '--cp-i': i } as CSSProperties}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              {step}
            </li>
          ))}
          <li
            className="cp-stagger-item col-span-2 mt-1 flex items-center justify-center gap-2"
            style={{ '--cp-i': 4 } as CSSProperties}
          >
            <span aria-hidden="true" className="font-mono text-base leading-none text-primary">
              ↻
            </span>
            and learns from every outcome
          </li>
        </ol>
        <Link to="/about" className="mt-7 inline-block text-sm text-accent-cool hover:underline">
          Read the full story →
        </Link>
      </section>

      {/* Viewport 2 — pipeline strip (PORTAL §5.1): the search as a live pipeline,
          reusing the compact pipeline; clicking through opens /pipeline. Rendered
          from first paint (skeleton while the first poll lands) so it holds its
          space instead of popping in — there's essentially always live data here.
          A cold backend error is the one case it collapses (no stranded skeleton). */}
      {pipelineStatus !== 'error' ? (
        <section
          ref={pipelineReveal.ref}
          aria-labelledby="home-pipeline-heading"
          className={cn('mt-24 w-full', pipelineReveal.className)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2
              id="home-pipeline-heading"
              className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"
            >
              My job search, live
              <InfoTip label="My job search, live" align="text">
                Every role I’m actively pursuing, as a live pipeline. Companies stay anonymized until each process
                closes — a deliberate privacy choice. Tap any stage on the pipeline page to follow it.
              </InfoTip>
            </h2>
            <Link to="/pipeline" className="shrink-0 font-mono text-xs text-accent-cool hover:underline">
              track it →
            </Link>
          </div>
          <PipelineCompact apps={apps} loading={pipelineStatus === 'loading'} expandLabels />
          <p className="mt-3 text-[11px] text-muted-foreground">
            Companies are obfuscated until each process closes — a deliberate privacy choice.
          </p>
        </section>
      ) : null}

      {/* Viewport 3 — agent-activity hook. The "see it all →" link is the
          contextual bridge into the ops register (PORTAL §5.1 / §24.35 Pass A).
          Wrapped in a full-width reveal carrier so it joins the scroll choreography
          (LiveTicker owns its own `mt-24`, which collapses through this border-less
          div unchanged). */}
      <div ref={tickerReveal.ref} className={cn('w-full', tickerReveal.className)}>
        <LiveTicker
          events={events}
          status={status}
          action={
            <Link to="/dashboard" className="font-mono text-xs text-accent-cool hover:underline">
              see it all →
            </Link>
          }
        />
      </div>

      {/* Viewport 4 — the "watch me apply" pitch (PORTAL §5.1): a single high-intent
          CTA into the grippiest spoke. No form here — the form lives on /watch. */}
      <section
        ref={watchReveal.ref}
        aria-labelledby="home-watch-heading"
        className={cn('mt-24 w-full text-center', watchReveal.className)}
      >
        <h2 id="home-watch-heading" className="text-2xl font-bold tracking-tight">
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
      <section
        ref={teaserReveal.ref}
        data-testid="home-teaser"
        aria-labelledby="home-teaser-heading"
        // `cp-still` + per-column `cp-stagger-item`: the three teaser columns
        // cascade in rather than the grid rising as one block (§24.147 fu).
        className={cn('mt-24 grid w-full gap-10 sm:grid-cols-3 cp-still', teaserReveal.className)}
      >
        <h2 id="home-teaser-heading" className="sr-only">
          More about me
        </h2>
        <div className="cp-stagger-item flex flex-col gap-2" style={{ '--cp-i': 0 } as CSSProperties}>
          <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Skills</h3>
          <ul className="flex flex-col gap-1 text-sm text-foreground/90">
            {p.skills.slice(0, 5).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="cp-stagger-item flex flex-col gap-2" style={{ '--cp-i': 1 } as CSSProperties}>
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
        <div className="cp-stagger-item flex flex-col gap-2" style={{ '--cp-i': 2 } as CSSProperties}>
          <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Talk to me</h3>
          {/* Contact form only — no plain-text email (§24.83 D5): the form is the
              relay, and a public mailto invites scraping (matches the footer). */}
          <Link to="/contact" search={{ from: 'home' }} className="text-sm text-accent-cool hover:underline">
            Contact form →
          </Link>
        </div>
      </section>
    </main>
  )
}
