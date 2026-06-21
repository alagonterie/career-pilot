import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { seo } from '~/lib/seo'
import { PERSON_NAME } from '~/lib/site'

// The formal privacy policy (§24.148). Distinct from the visitor-privacy NARRATIVE
// at /about#privacy: this is the disclosure Google's OAuth consent screen points to
// for the Gmail user-data the agent processes (the Limited Use affirmation). It's a
// footer-linked legal page, deliberately NOT a top-nav item — so it doesn't reopen
// the "no nav clutter" call behind /about#privacy. Identity-safe: the operator is
// the build-time `PERSON_NAME` (placeholder in the repo), contact routes through
// /contact, and no real address/domain is hardcoded.
export const Route = createFileRoute('/(marketing)/privacy')({
  component: PrivacyPage,
  head: () =>
    seo({
      title: `Privacy — ${PERSON_NAME}`,
      description: 'How this site and its job-search agent handle visitor data and Google account data.',
      path: '/privacy',
    }),
})

// The latest revision date, shown to the reader. Bump this whenever the policy
// changes (the cutover tag is the natural first bump).
const LAST_UPDATED = 'June 21, 2026'

function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section data-testid={id} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function PrivacyPage() {
  return (
    <main data-testid="privacy" className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Privacy</h1>
        <p className="font-mono text-xs text-muted-foreground">Last updated: {LAST_UPDATED}</p>
      </header>

      <p className="text-balance leading-relaxed text-foreground/90">
        This site is the personal hiring portal and job-search automation operated by {PERSON_NAME} (“I”, “me”). It runs
        an AI agent system that manages my own job search. This policy covers two separate things: what the site records
        about your visit, and what the agent does with my own Google account data.
      </p>

      <Section title="Your data as a visitor">
        <p className="leading-relaxed text-foreground/90">
          The site keeps a first-party log of visits to operate and improve the showcase — no third-party trackers, no
          cross-site cookies, and no ad-tech. If you use the contact form, your message is relayed straight to me; the
          contact form and the “watch it work” simulator are protected from abuse by Cloudflare Turnstile. There is no
          public sign-in, so you never grant the agent any access by browsing, running the simulator, or sending a
          message. The fuller, plain-English version of this lives in{' '}
          <Link to="/about" hash="privacy" className="text-accent-cool hover:underline">
            the About page
          </Link>
          .
        </p>
      </Section>

      <Section id="privacy-google-data" title="Google account data">
        <p className="leading-relaxed text-foreground/90">
          To run my job search, the agent connects to <strong className="font-semibold text-foreground">my own</strong>{' '}
          Google account using OAuth. It requests these permissions:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 leading-relaxed text-foreground/90">
          <li>
            <span className="font-mono text-sm text-foreground">gmail.readonly</span> — read incoming mail to spot
            recruiter and job-related messages.
          </li>
          <li>
            <span className="font-mono text-sm text-foreground">gmail.modify</span> — organize that mail (labels) and
            prepare drafts.
          </li>
          <li>
            <span className="font-mono text-sm text-foreground">gmail.send</span> — send outreach emails on my behalf.
          </li>
          <li>
            basic profile (<span className="font-mono text-sm text-foreground">email</span>,{' '}
            <span className="font-mono text-sm text-foreground">profile</span>,{' '}
            <span className="font-mono text-sm text-foreground">openid</span>) — to sign the agent in to the right
            account.
          </li>
        </ul>
        <p className="leading-relaxed text-foreground/90">How that data is handled:</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 leading-relaxed text-foreground/90">
          <li>
            It is used only to operate features of this service for me — triaging job-related mail, researching roles,
            and drafting and sending outreach.
          </li>
          <li>
            To research and draft text, message content may be sent to an AI model (Anthropic’s Claude, via the Portkey
            gateway) to return a result. Under those providers’ API terms, the content is not retained to train their
            models.
          </li>
          <li>It is stored only in this service’s own private database, on infrastructure I control.</li>
          <li>It is never sold, never shared for advertising, and never used to build advertising profiles.</li>
          <li>No human other than me reads it.</li>
        </ul>
        <p className="leading-relaxed text-foreground/90">
          This service’s use of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
            className="text-accent-cool hover:underline"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section title="Retention and deletion">
        <p className="leading-relaxed text-foreground/90">
          The agent keeps only what it needs to act on my job search (for example, the application-pipeline records it
          builds). I can revoke its access to my Google account at any time from my Google Account’s security settings,
          which immediately stops all further access.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p className="leading-relaxed text-foreground/90">
          I may update this policy; the date above reflects the latest version. Questions about it can go through{' '}
          <Link to="/contact" search={{ from: 'privacy' }} className="text-accent-cool hover:underline">
            the contact form
          </Link>
          .
        </p>
      </Section>
    </main>
  )
}
