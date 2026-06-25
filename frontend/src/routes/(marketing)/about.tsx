import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { AgentMark } from '~/components/AgentMark'
import { LONGFORM_SCROLL_MT, LongformDoc } from '~/components/longform/LongformDoc'
import { HandleChip } from '~/components/pipeline/CompanyHandle'
import { AI_ACTORS } from '~/lib/ai-actors'
import { seo } from '~/lib/seo'
import { getWorkProfile } from '~/lib/profile-loader'
import { REPO_URL } from '~/lib/site'
import { deriveTelemetryView, useTelemetry } from '~/lib/use-telemetry'
import { cn } from '~/lib/utils'
import { workProfile } from '~/lib/work-profile'

// `/about` — the "tell" surface (PORTAL §5.8 / STRATEGY §24.75). The companion to
// the `/architecture` *proof* page: that one SHOWS the live system; this one TELLS
// the story and substantiates it. Deliberately NOT in the header (§8.1) — reached
// from the home pitch beat ("Read the full story →") and the footer ("About"; the
// sitewide footer is a separate slice). Marketing register, story-first.
//
// Arc (§5.8): story → how-it-works-in-words → meet-the-cast → anonymization
// (#anonymization, deep-linked from /experience + the pipeline) → the trust depth
// (vault, visitor privacy, modes, cost, tech, fork, honest limits) → FAQ. Story
// warm, deepening into precise. It's a long wall of text, so it adopts the shared
// long-form scaffold (§24.83): a document masthead + a sticky scroll-spy TOC.
export const Route = createFileRoute('/(marketing)/about')({
  component: AboutPage,
  // SSR the candidate's name for the title (identity-SSR principle — never the
  // hardcoded placeholder; fall back to the typed placeholder when uncomposed).
  loader: () => getWorkProfile(),
  head: ({ loaderData }) =>
    seo({
      title: `About — ${loaderData?.profile?.name ?? workProfile.name}`,
      description: 'Why I built an AI agent system to run my job search, and how it actually works — in plain English.',
      path: '/about',
    }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

// The ordered section model (§24.83 D2): a short `nav` label for the TOC rail +
// the full `heading` for the section h2, so the rail stays scannable while the
// headings stay sentence-length. The `id`s are the section anchors — `anonymization`
// and `privacy` are deep-linked from elsewhere on the site and must not change.
type AboutMeta = { id: string; nav: string; heading: string }
const ABOUT_SECTIONS: AboutMeta[] = [
  { id: 'story', nav: 'The story', heading: 'The story' },
  { id: 'how-it-works', nav: 'How it works', heading: 'How it works, in words' },
  { id: 'cast', nav: 'The cast', heading: 'Meet the cast' },
  { id: 'anonymization', nav: 'Anonymization', heading: 'Why companies are hidden' },
  { id: 'vault', nav: 'Credentials', heading: 'Where the keys live' },
  { id: 'privacy', nav: 'Your privacy', heading: 'What this site logs about your visit' },
  { id: 'safety', nav: 'Safety', heading: 'Safety controls' },
  { id: 'cost', nav: 'Cost', heading: 'What it costs to run' },
  { id: 'stack', nav: 'The stack', heading: 'The stack, and why' },
  { id: 'fork', nav: 'Fork it', heading: 'Fork it for your own search' },
  { id: 'limits', nav: "What it doesn't do", heading: "What it doesn't do" },
  { id: 'faq', nav: 'Questions', heading: 'Questions I get' },
]
const M = Object.fromEntries(ABOUT_SECTIONS.map((s) => [s.id, s])) as Record<string, AboutMeta>

/** Cents → a dollar string. Sub-cent figures keep 4 decimals so they don't all
 *  collapse to "$0.00"; anything ≥ 1¢ shows the familiar 2 (matches /dashboard). */
function fmtCentsUsd(cents: number): string {
  const usd = cents / 100
  return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

/** A navigable section: the wrapper carries the scaffold's `data-longform-section`
 *  anchor + the shared scroll-margin + the stable `id`; the h2 is the heading. */
function S({ meta, gap = 'gap-3', children }: { meta: AboutMeta; gap?: string; children: React.ReactNode }) {
  return (
    <section
      id={meta.id}
      data-longform-section={meta.id}
      aria-labelledby={`h-${meta.id}`}
      className={cn('flex flex-col', gap, LONGFORM_SCROLL_MT)}
    >
      <h2 id={`h-${meta.id}`} className="text-lg font-semibold tracking-tight text-foreground">
        {meta.heading}
      </h2>
      {children}
    </section>
  )
}

/** Meet the cast — the AI roster, read straight from the §24.73 registry so it
 *  agrees with every other mention on the site. The blurbs are shown inline (this
 *  is the explainer page); each name is still an explainable AgentMark chip. */
function CastRoster() {
  return (
    <ul data-testid="about-cast" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {AI_ACTORS.map((a) => (
        <li key={a.name} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
          <AgentMark actor={a.name} />
          <p className="text-sm font-semibold text-foreground">{a.role}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{a.blurb}</p>
          <p className="mt-auto pt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {a.access}
          </p>
        </li>
      ))}
    </ul>
  )
}

/** What it costs — the honest live figure, reusing the SAME public telemetry the
 *  /dashboard "LLM spend" panel shows (no new endpoint, §24.75 D4). SDK estimates,
 *  so labeled `est`; degrades to an honest pending line before the first turn. */
function CostFigures() {
  const t = useTelemetry(API_BASE)
  const { local } = deriveTelemetryView(t.data)
  const totalCents = local ? local.turn_cost_cents_total + local.sim_cost_cents_total : 0
  const cache = local?.cache_hit_rate ?? null

  return (
    <>
      <p className="text-balance leading-relaxed text-foreground/90">
        I’d rather show the number than wave at it. This is the live tally from the system’s own telemetry — every model
        call it has made, summed up.
      </p>
      {local && totalCents > 0 ? (
        <div data-testid="about-cost" className="flex flex-wrap gap-x-10 gap-y-4">
          <div className="flex flex-col">
            <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {fmtCentsUsd(totalCents)}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              spent so far · est
            </span>
          </div>
          {cache != null ? (
            <div className="flex flex-col">
              <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
                {Math.round(cache * 100)}%
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                cache hit · keeps it cheap
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <p data-testid="about-cost-pending" className="font-mono text-xs text-muted-foreground">
          The meter starts once the first agent turn runs.
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        These are estimates summed from per-call model usage at list prices — not a bill. Prompt caching re-serves
        unchanged context instead of reprocessing it, which is why a system that runs all day costs what a coffee does.
      </p>
    </>
  )
}

function AboutPage() {
  const tocSections = ABOUT_SECTIONS.map((s) => ({ id: s.id, title: s.nav }))

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      {/* Document masthead — the §24.83 / §5.9 register, in the marketing voice. */}
      <header className="border-b border-border pb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Why I built this</h1>
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            The long version
          </span>
        </div>
        <p className="mt-3 text-balance text-base leading-relaxed text-muted-foreground">
          The short version is on the home page. This is the long one — what this system is, why it’s a genuinely better
          way to run a job search, and how it works under the hood. No marketing gloss; just the honest account.
        </p>
      </header>

      <div className="mt-8">
        <LongformDoc
          sections={tocSections}
          idPrefix="about"
          navLabel="On this page"
          stepper
          contentClassName="flex flex-col gap-10"
        >
          <S meta={M.story}>
            <p className="text-balance leading-relaxed text-foreground/90">
              A real job search is mostly repetition. For every role worth applying to, you research the company,
              re-tailor your résumé to what they actually need, write outreach that doesn’t read like a template, and
              prepare for the conversations — then you do it again, dozens of times, while keeping track of where
              everything stands. Done well it’s a part-time job; done at volume it’s impossible to do well by hand.
            </p>
            <p className="text-balance leading-relaxed text-foreground/90">
              So I built an AI agent system that runs that loop for me — continuously, and with me still in the driver’s
              seat. It does the grind so my attention goes to the parts that actually need a human: the conversations,
              the judgment calls, the decision about which opportunities are worth pursuing. Everything it produces is
              grounded in my real experience — it selects and re-emphasizes what’s true for a given role, it never
              invents a skill or a result I don’t have.
            </p>
            <p className="text-balance leading-relaxed text-foreground/90">
              And rather than describe all of that, I decided to <em>show</em> it. This entire site is the system,
              running live: the pipeline you can watch, the agents working in real time, and a live run that will tailor
              my materials to <em>your</em> open role on the spot. The showcase is the product — which is also the most
              honest portfolio piece I could build, because you can check every claim against the thing actually doing
              the work.
            </p>
          </S>

          <S meta={M['how-it-works']}>
            <p className="text-balance leading-relaxed text-foreground/90">
              The system runs a continuous loop, and I approve anything that leaves it:
            </p>
            <ul className="flex flex-col gap-3 leading-relaxed text-foreground/90">
              <li>
                <span className="font-semibold text-foreground">It finds roles.</span> It watches job sources for
                openings worth applying to and keeps a running shortlist, so the search never goes cold.
              </li>
              <li>
                <span className="font-semibold text-foreground">It researches and tailors.</span> For a given role it
                studies the company and re-frames my résumé toward what they need — selecting from real experience,
                never fabricating. Re-emphasis, not embellishment.
              </li>
              <li>
                <span className="font-semibold text-foreground">It drafts the outreach.</span> It writes a cold-outreach
                email I can review and send — a reversible draft, never sent on its own.
              </li>
              <li>
                <span className="font-semibold text-foreground">It builds interview prep.</span> When a process
                advances, it assembles a prep dossier grounded in the role and my background.
              </li>
              <li>
                <span className="font-semibold text-foreground">It learns from outcomes.</span> After a rejection or an
                interview it talks it through with me, and when a pattern shows up it coaches — “three rejections this
                month all at the system-design round; worth focusing prep there?” It files what’s worth remembering, so
                the next time it tailors for a similar role it leads with the strength a past miss left under-weighted.
                It’s memory, not magic: the system gets sharper because it remembers, not because it retrains itself.
              </li>
            </ul>
            <p className="text-balance leading-relaxed text-foreground/90">
              Want the technical version? The{' '}
              <Link
                to="/architecture"
                className="text-accent-cool underline decoration-accent-cool/40 underline-offset-2 hover:decoration-accent-cool"
              >
                live system map
              </Link>{' '}
              shows every moving part with real-time status, and the whole thing is open source —{' '}
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="text-accent-cool underline decoration-accent-cool/40 underline-offset-2 hover:decoration-accent-cool"
              >
                read the code ↗
              </a>
              .
            </p>
          </S>

          <S meta={M.cast} gap="gap-4">
            <p className="text-balance leading-relaxed text-foreground/90">
              The search isn’t one AI — it’s a small cast of specialists the orchestrator hands work to, plus a couple
              of models that run on their own. Each does one job, and the site names them honestly wherever they show
              up.
            </p>
            <CastRoster />
          </S>

          <S meta={M.anonymization}>
            <p className="text-balance leading-relaxed text-foreground/90">
              While a hiring process is live, the company shows as a category label — <HandleChip label="fintech-b" />,
              not the real name. That’s deliberate. I reveal a name only when it’s appropriate: a closed process the
              company is fine making public, or a lesson worth sharing. And no personal details — recruiter names, email
              addresses, scheduling links — ever appear anywhere; they’re stripped before anything is shown. It protects
              the companies and the people I’m actually talking to, and being upfront about it is itself the point.
            </p>
          </S>

          <S meta={M.vault}>
            <p className="text-balance leading-relaxed text-foreground/90">
              No raw API key ever enters the agent’s container. Credentials are split across two purpose-built vaults:
              one holds the model-provider key, so the container only ever talks to a gateway that makes the real call;
              the other holds everything else — the Google sign-in, the chat-bot token — and injects each one at request
              time based on where the request is headed. The container’s own environment contains exactly zero secrets.
              It’s how serious AI shops run agents in production — not security theater.
            </p>
          </S>

          <S meta={M.privacy}>
            <p className="text-balance leading-relaxed text-foreground/90">
              This site keeps a <strong className="font-semibold text-foreground">first-party</strong> log of visits —
              no third-party trackers, no cross-site cookies, no ad-tech. When I share a link to this showcase — on my
              LinkedIn, on a résumé I hand out, or in a cold-outreach email the agent sends — that link carries a short
              note of where it came from, so a click tells me which channel found me. For anything I post or hand out
              that note is a <strong className="font-semibold text-foreground">plain-text label</strong> you can read
              right in the address bar (something like <code className="font-mono text-sm">?from=my_linkedin</code>) —
              not even hidden in a code; a one-to-one outreach email keeps a short unique code so I can tell which
              company opened it. That’s the whole point of a public job-search showcase. The log keeps a salted hash of
              your IP (enough to tell a repeat visit from a new one, without storing the address itself), a coarse
              country, and which page you landed on — held for a bounded window, then deleted, and visible only to me
              behind an authenticated page. A “watch it work” run works the same way: the company, role, and job
              description you enter and a redacted trace of the run are stored privately on the same terms — visible
              only to me, deleted after a bounded window — while the public recent-runs list shows nothing but aggregate
              cost and runtime. I deliberately turned down the free third-party analytics beacon; I’d rather keep the
              whole thing first-party and legible.
            </p>
          </S>

          <S meta={M.safety}>
            <p className="text-balance leading-relaxed text-foreground/90">
              The system runs with explicit guardrails: a shadow-versus-live distinction, a pause switch that halts all
              activity at once, and per-action budgets and caps so it can’t run away. Anything irreversible or
              outward-facing is gated — nothing sends without my say-so. The current operating mode is shown on the{' '}
              <Link
                to="/architecture"
                className="text-accent-cool underline decoration-accent-cool/40 underline-offset-2 hover:decoration-accent-cool"
              >
                system map
              </Link>
              .
            </p>
          </S>

          <S meta={M.cost}>
            <CostFigures />
          </S>

          <S meta={M.stack}>
            <ul className="flex flex-col gap-2 leading-relaxed text-foreground/90">
              <li>
                <span className="font-semibold text-foreground">NanoClaw</span> — the open-source agent host it’s built
                on; I forked and customized it rather than reinvent the harness.
              </li>
              <li>
                <span className="font-semibold text-foreground">Claude Agent SDK</span> — the in-process agent runtime;
                the orchestrator and its specialists are Claude.
              </li>
              <li>
                <span className="font-semibold text-foreground">Portkey</span> — the gateway every model call routes
                through: one place to watch cost, and the provider key never enters the container.
              </li>
              <li>
                <span className="font-semibold text-foreground">OneCLI</span> — the credential vault that injects
                everything else on the wire.
              </li>
              <li>
                <span className="font-semibold text-foreground">TanStack Start on Cloudflare Workers</span> — the site
                you’re reading: type-safe and served from the edge.
              </li>
            </ul>
          </S>

          <S meta={M.fork}>
            <p className="text-balance leading-relaxed text-foreground/90">
              The repository is fully generic — there’s no hardcoded personal data in it. Fork it, run the setup, and
              walk the onboarding to populate your own profile; none of my content lives in the repo.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-card p-4 font-mono text-xs text-muted-foreground">
              <code>{`git clone <repo>\ncd career-pilot\nbash setup.sh`}</code>
            </pre>
          </S>

          <S meta={M.limits}>
            <ul className="flex flex-col gap-2 leading-relaxed text-foreground/90">
              <li>It never sends anything on its own — outreach lands as a draft I review first.</li>
              <li>It doesn’t apply to jobs for me, or talk to recruiters as me.</li>
              <li>The odds-of-an-offer score is a heuristic that moves as new signals arrive — not a promise.</li>
              <li>
                It’s tuned to my search, not packaged as a product (yet) — though it’s built generic so it could be.
              </li>
            </ul>
          </S>

          <S meta={M.faq} gap="gap-4">
            <dl className="flex flex-col gap-5">
              <div className="flex flex-col gap-1">
                <dt className="font-semibold text-foreground">Is it actually autonomous, or are you driving it?</dt>
                <dd className="leading-relaxed text-muted-foreground">
                  Both. It runs on its own on a schedule — scouting roles, watching for replies — and reacts when I chat
                  with it. I approve anything that goes outward.
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-semibold text-foreground">Did an AI write your résumé?</dt>
                <dd className="leading-relaxed text-muted-foreground">
                  It tailors my real résumé by selecting and re-emphasizing real experience for a given role. It never
                  invents — every line maps to something I’ve actually done.
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-semibold text-foreground">Can I see it work on my role?</dt>
                <dd className="leading-relaxed text-muted-foreground">
                  Yes —{' '}
                  <Link
                    to="/watch"
                    className="text-accent-cool underline decoration-accent-cool/40 underline-offset-2 hover:decoration-accent-cool"
                  >
                    Watch it work
                  </Link>{' '}
                  runs the same agent stack on your company and a role you’re hiring for, live.
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-semibold text-foreground">Are you tracking me?</dt>
                <dd className="leading-relaxed text-muted-foreground">
                  Only a first-party visit log — see above. No third-party trackers, no cross-site cookies.
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-semibold text-foreground">
                  How do you change it without breaking the live search?
                </dt>
                <dd className="leading-relaxed text-muted-foreground">
                  Changes ship through a separate, access-gated copy of the whole system first — a simulated recruiter
                  drives it end-to-end so new behavior gets shaken out before it ever touches the real search. And on
                  the live system, shadow mode lets it dry-run an action before that action is ever armed — the same
                  staged-rollout discipline I’d bring to any production system.
                </dd>
              </div>
            </dl>
          </S>
        </LongformDoc>
      </div>
    </main>
  )
}
