import { createFileRoute, Link } from '@tanstack/react-router'

import { seo } from '~/lib/seo'
import { getWorkProfile } from '~/lib/profile-loader'
import { REPO_URL } from '~/lib/site'
import { workProfile } from '~/lib/work-profile'

// `/about` — the "tell" surface (PORTAL §5.8 / STRATEGY §24.75). The companion to
// the `/architecture` *proof* page: that one SHOWS the live system; this one TELLS
// the story and substantiates it. Deliberately NOT in the header (§8.1) — reached
// from the home pitch beat ("Read the full story →") and, once wired, the footer
// ("About"). Marketing register, story-first.
//
// Commit 2 (§24.75) ships the opening: the value narrative + how-it-works-in-words.
// Commit 3 fills in the rest of the §5.8 arc — meet-the-cast (the `ai-actors`
// registry), the trust depth (the `#anonymization` anchor, the two-tier vault,
// visitor privacy, modes, tech choices, fork, honest limitations), the cost section
// (over the existing `/api/telemetry`), and the FAQ — plus the connective rail row
// and the footer doorway.
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
        <h2 className="text-lg font-semibold tracking-tight text-foreground">The story</h2>
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
        <h2 className="text-lg font-semibold tracking-tight text-foreground">How it works, in words</h2>
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
          <Link to="/architecture" className="text-accent-cool hover:underline">
            live system map
          </Link>{' '}
          shows every moving part with real-time status, and the whole thing is open source —{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-accent-cool hover:underline">
            read the code ↗
          </a>
          .
        </p>
      </section>
    </main>
  )
}
