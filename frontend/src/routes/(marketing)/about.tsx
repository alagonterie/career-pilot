import { createFileRoute, Link } from '@tanstack/react-router'

import { AgentMark } from '~/components/AgentMark'
import { AI_ACTORS } from '~/lib/ai-actors'
import { seo } from '~/lib/seo'
import { getWorkProfile } from '~/lib/profile-loader'
import { REPO_URL } from '~/lib/site'
import { deriveTelemetryView, useTelemetry } from '~/lib/use-telemetry'
import { workProfile } from '~/lib/work-profile'

// `/about` — the "tell" surface (PORTAL §5.8 / STRATEGY §24.75). The companion to
// the `/architecture` *proof* page: that one SHOWS the live system; this one TELLS
// the story and substantiates it. Deliberately NOT in the header (§8.1) — reached
// from the home pitch beat ("Read the full story →") and the footer ("About"; the
// sitewide footer is a separate slice). Marketing register, story-first.
//
// Arc (§5.8): story → how-it-works-in-words → meet-the-cast → anonymization
// (#anonymization, deep-linked from /work + the funnel) → the trust depth (vault,
// visitor privacy, modes, cost, tech, fork, honest limits) → FAQ. Story warm,
// deepening into precise.
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

/** Cents → a dollar string. Sub-cent figures keep 4 decimals so they don't all
 *  collapse to "$0.00"; anything ≥ 1¢ shows the familiar 2 (matches /live). */
function fmtCentsUsd(cents: number): string {
  const usd = cents / 100
  return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

function Heading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 text-lg font-semibold tracking-tight text-foreground">
      {children}
    </h2>
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
 *  /live "LLM spend" panel shows (no new endpoint, §24.75 D4). SDK estimates, so
 *  labeled `est`; degrades to an honest pending line before the first turn. */
function CostSection() {
  const t = useTelemetry(API_BASE)
  const { local } = deriveTelemetryView(t.data)
  const totalCents = local ? local.turn_cost_cents_total + local.sim_cost_cents_total : 0
  const cache = local?.cache_hit_rate ?? null

  return (
    <section className="flex flex-col gap-3">
      <Heading>What it costs to run</Heading>
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
    </section>
  )
}

function AboutPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Why I built this</h1>
        <p className="text-balance text-base leading-relaxed text-muted-foreground">
          The short version is on the home page. This is the long one — what this system is, why it’s a genuinely better
          way to run a job search, and how it works under the hood. No marketing gloss; just the honest account.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <Heading>The story</Heading>
        <p className="text-balance leading-relaxed text-foreground/90">
          A real job search is mostly repetition. For every role worth applying to, you research the company, re-tailor
          your résumé to what they actually need, write outreach that doesn’t read like a template, and prepare for the
          conversations — then you do it again, dozens of times, while keeping track of where everything stands. Done
          well it’s a part-time job; done at volume it’s impossible to do well by hand.
        </p>
        <p className="text-balance leading-relaxed text-foreground/90">
          So I built an AI agent system that runs that loop for me — continuously, and with me still in the driver’s
          seat. It does the grind so my attention goes to the parts that actually need a human: the conversations, the
          judgment calls, the decision about which opportunities are worth pursuing. Everything it produces is grounded
          in my real experience — it selects and re-emphasizes what’s true for a given role, it never invents a skill or
          a result I don’t have.
        </p>
        <p className="text-balance leading-relaxed text-foreground/90">
          And rather than describe all of that, I decided to <em>show</em> it. This entire site is the system, running
          live: the pipeline you can watch, the agents working in real time, a simulator that will tailor my materials
          to <em>your</em> open role on the spot. The showcase is the product — which is also the most honest portfolio
          piece I could build, because you can check every claim against the thing actually doing the work.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>How it works, in words</Heading>
        <p className="text-balance leading-relaxed text-foreground/90">
          The system runs a continuous loop, and I approve anything that leaves it:
        </p>
        <ul className="flex flex-col gap-3 leading-relaxed text-foreground/90">
          <li>
            <span className="font-semibold text-foreground">It finds roles.</span> It watches job sources for openings
            worth applying to and keeps a running shortlist, so the search never goes cold.
          </li>
          <li>
            <span className="font-semibold text-foreground">It researches and tailors.</span> For a given role it
            studies the company and re-frames my résumé toward what they need — selecting from real experience, never
            fabricating. Re-emphasis, not embellishment.
          </li>
          <li>
            <span className="font-semibold text-foreground">It drafts the outreach.</span> It writes a cold-outreach
            email I can review and send — a reversible draft, never sent on its own.
          </li>
          <li>
            <span className="font-semibold text-foreground">It builds interview prep.</span> When a process advances, it
            assembles a prep dossier grounded in the role and my background.
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
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Heading>Meet the cast</Heading>
          <p className="text-balance leading-relaxed text-foreground/90">
            The search isn’t one AI — it’s a small cast of specialists the orchestrator hands work to, plus a couple of
            models that run on their own. Each does one job, and the site names them honestly wherever they show up.
          </p>
        </div>
        <CastRoster />
      </section>

      <section id="anonymization" className="flex scroll-mt-24 flex-col gap-3">
        <Heading>Why companies are hidden</Heading>
        <p className="text-balance leading-relaxed text-foreground/90">
          While a hiring process is live, the company shows as a category label — “fintech-b”, not the real name. That’s
          deliberate. I reveal a name only when it’s appropriate: a closed process the company is fine making public, or
          a lesson worth sharing. And no personal details — recruiter names, email addresses, scheduling links — ever
          appear anywhere; they’re stripped before anything is shown. It protects the companies and the people I’m
          actually talking to, and being upfront about it is itself the point.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>Where the keys live</Heading>
        <p className="text-balance leading-relaxed text-foreground/90">
          No raw API key ever enters the agent’s container. Credentials are split across two purpose-built vaults: one
          holds the model-provider key, so the container only ever talks to a gateway that makes the real call; the
          other holds everything else — the Google sign-in, the chat-bot token — and injects each one at request time
          based on where the request is headed. The container’s own environment contains exactly zero secrets. It’s how
          serious AI shops run agents in production — not security theater.
        </p>
      </section>

      <section id="privacy" className="flex scroll-mt-24 flex-col gap-3">
        <Heading>What this site logs about your visit</Heading>
        <p className="text-balance leading-relaxed text-foreground/90">
          This site keeps a <strong className="font-semibold text-foreground">first-party</strong> log of visits — no
          third-party trackers, no cross-site cookies, no ad-tech. When the agent puts a link to this showcase into
          something it sends out — a cold-outreach email, or a résumé that gets forwarded — that link carries a short
          opaque code, so a click tells me which outreach it came from. That’s the whole point of a public job-search
          showcase. The log keeps a salted hash of your IP (enough to tell a repeat visit from a new one, without
          storing the address itself), a coarse country, and which page you landed on — held for a bounded window, then
          deleted, and visible only to me behind an authenticated page. I deliberately turned down the free third-party
          analytics beacon; I’d rather keep the whole thing first-party and legible.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>Safety controls</Heading>
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
      </section>

      <CostSection />

      <section className="flex flex-col gap-3">
        <Heading>The stack, and why</Heading>
        <ul className="flex flex-col gap-2 leading-relaxed text-foreground/90">
          <li>
            <span className="font-semibold text-foreground">NanoClaw</span> — the open-source agent host it’s built on;
            I forked and customized it rather than reinvent the harness.
          </li>
          <li>
            <span className="font-semibold text-foreground">Claude Agent SDK</span> — the in-process agent runtime; the
            orchestrator and its specialists are Claude.
          </li>
          <li>
            <span className="font-semibold text-foreground">Portkey</span> — the gateway every model call routes
            through: one place to watch cost, and the provider key never enters the container.
          </li>
          <li>
            <span className="font-semibold text-foreground">OneCLI</span> — the credential vault that injects everything
            else on the wire.
          </li>
          <li>
            <span className="font-semibold text-foreground">TanStack Start on Cloudflare Workers</span> — the site
            you’re reading: type-safe and served from the edge.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>Fork it for your own search</Heading>
        <p className="text-balance leading-relaxed text-foreground/90">
          The repository is fully generic — there’s no hardcoded personal data in it. Fork it, run the setup, and walk
          the onboarding to populate your own profile; none of my content lives in the repo.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-card p-4 font-mono text-xs text-muted-foreground">
          <code>{`git clone <repo>\ncd career-pilot\nbash setup.sh`}</code>
        </pre>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>What it doesn’t do</Heading>
        <ul className="flex flex-col gap-2 leading-relaxed text-foreground/90">
          <li>It never sends anything on its own — outreach lands as a draft I review first.</li>
          <li>It doesn’t apply to jobs for me, or talk to recruiters as me.</li>
          <li>The odds-of-an-offer score is a heuristic that moves as new signals arrive — not a promise.</li>
          <li>It’s tuned to my search, not packaged as a product (yet) — though it’s built generic so it could be.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <Heading>Questions I get</Heading>
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
              Yes — the{' '}
              <Link
                to="/watch"
                className="text-accent-cool underline decoration-accent-cool/40 underline-offset-2 hover:decoration-accent-cool"
              >
                simulator
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
        </dl>
      </section>
    </main>
  )
}
