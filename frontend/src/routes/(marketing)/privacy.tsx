import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { LongformDoc, LONGFORM_SCROLL_MT, type DocSection } from '~/components/longform/LongformDoc'
import { seo } from '~/lib/seo'
import { PERSON_NAME } from '~/lib/site'
import { cn } from '~/lib/utils'

// The formal privacy policy (§24.148). Distinct from the visitor-privacy NARRATIVE
// at /about#privacy: this is the disclosure Google's OAuth consent screen points to
// for the Google user-data the agent processes — Gmail / Calendar / Drive (the
// Limited Use affirmation). On the
// shared long-form scaffold (§24.83), like /about + /experience, so it reads as a
// site document, not a one-off page. Footer-linked, deliberately NOT a top-nav item.
// Identity-safe: operator = the build-time `PERSON_NAME` (placeholder in the repo),
// contact via /contact, no real address/domain hardcoded.
export const Route = createFileRoute('/(marketing)/privacy')({
  component: PrivacyPage,
  head: () =>
    seo({
      title: `Privacy — ${PERSON_NAME}`,
      description: 'How this site and its job-search agent handle visitor data and Google account data.',
      path: '/privacy',
    }),
})

// Bump whenever the policy changes (the cutover tag is the natural first bump).
const LAST_UPDATED = 'June 21, 2026'

const SECTIONS: DocSection[] = [
  { id: 'visitor', title: 'Your visit' },
  { id: 'google-data', title: 'Google account data' },
  { id: 'retention', title: 'Retention & deletion' },
  { id: 'contact', title: 'Changes & contact' },
]
const M = Object.fromEntries(SECTIONS.map((s) => [s.id, s])) as Record<string, DocSection>

/** A navigable section: carries the scaffold's `data-longform-section` anchor + the
 *  shared scroll-margin + a stable `id`; the h2 is the heading. `testId` is for the
 *  one section the footer e2e asserts on (the Limited Use disclosure). */
function Sec({ section, testId, children }: { section: DocSection; testId?: string; children: ReactNode }) {
  return (
    <section
      id={section.id}
      data-longform-section={section.id}
      data-testid={testId}
      aria-labelledby={`h-${section.id}`}
      className={cn('flex flex-col gap-3', LONGFORM_SCROLL_MT)}
    >
      <h2 id={`h-${section.id}`} className="text-lg font-semibold tracking-tight text-foreground">
        {section.title}
      </h2>
      {children}
    </section>
  )
}

function PrivacyPage() {
  return (
    <main data-testid="privacy" className="mx-auto w-full max-w-4xl px-6 py-12">
      {/* Document masthead — the §24.83 / §5.9 register. */}
      <header className="border-b border-border pb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Privacy</h1>
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            The policy
          </span>
        </div>
        <p className="mt-3 text-balance text-base leading-relaxed text-muted-foreground">
          This site is the personal hiring portal and job-search automation operated by {PERSON_NAME}. This policy
          covers two separate things: what the site records about your visit, and what the agent does with my own Google
          account data.
        </p>
        <p className="mt-3 font-mono text-[11px] text-muted-foreground/80">Last updated: {LAST_UPDATED}</p>
      </header>

      <div className="mt-8">
        <LongformDoc
          sections={SECTIONS}
          idPrefix="privacy"
          navLabel="On this page"
          stepper
          contentClassName="flex flex-col gap-10"
        >
          <Sec section={M.visitor}>
            <p className="leading-relaxed text-foreground/90">
              The site keeps a first-party log of visits to operate and improve the showcase — no third-party trackers,
              no cross-site cookies, and no ad-tech. If you use the contact form, your message is relayed straight to
              me; the contact form and the “watch it work” simulator are protected from abuse by Cloudflare Turnstile.
              There is no public sign-in, so you never grant the agent any access by browsing, running the simulator, or
              sending a message.
            </p>
            <p className="leading-relaxed text-foreground/90">
              When you run the “watch it work” simulator, the run is saved — that’s how you get a shareable result, and
              how the abuse limits work. It keeps the company, role, and job description you enter, a redacted activity
              trace, the run’s cost and runtime, and your IP address; it’s stored only in this service’s private
              database, visible only to me, and deleted after a short retention window. The public “recent runs” list
              shows aggregate cost and runtime only — never the text you typed.
            </p>
            <p className="leading-relaxed text-foreground/90">
              The fuller, plain-English version of this lives in{' '}
              <Link to="/about" hash="privacy" className="text-accent-cool hover:underline">
                the About page
              </Link>
              .
            </p>
          </Sec>

          <Sec section={M['google-data']} testId="privacy-google-data">
            <p className="leading-relaxed text-foreground/90">
              To run my job search, the agent connects to{' '}
              <strong className="font-semibold text-foreground">my own</strong> Google account using OAuth. It requests
              these permissions:
            </p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 leading-relaxed text-foreground/90">
              <li>
                <span className="font-mono text-sm text-foreground">gmail.modify</span> — read, organize, and send
                email: spotting recruiter and job-related messages, labeling them, and drafting and sending outreach.
              </li>
              <li>
                <span className="font-mono text-sm text-foreground">calendar.events.owned</span> — create and manage
                events on my own calendars, to schedule interviews.
              </li>
              <li>
                <span className="font-mono text-sm text-foreground">drive.file</span> — create and manage only the Drive
                files the agent itself makes (for example, interview-prep documents) — never anything else in my Drive.
              </li>
              <li>
                basic profile (<span className="font-mono text-sm text-foreground">openid</span>,{' '}
                <span className="font-mono text-sm text-foreground">email</span>,{' '}
                <span className="font-mono text-sm text-foreground">profile</span>) — to sign the agent in to the right
                account.
              </li>
            </ul>
            <p className="leading-relaxed text-foreground/90">How that data is handled:</p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 leading-relaxed text-foreground/90">
              <li>
                It is used only to operate features of this service for me — triaging job-related mail, researching
                roles, drafting and sending outreach, scheduling interviews, and preparing interview-prep documents.
              </li>
              <li>
                To research and draft text, message content may be sent to an AI model (Anthropic’s Claude, via the
                Portkey gateway) to return a result. Under those providers’ API terms, the content is not retained to
                train their models.
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
          </Sec>

          <Sec section={M.retention}>
            <p className="leading-relaxed text-foreground/90">
              The agent keeps only what it needs to act on my job search (for example, the application-pipeline records
              it builds). I can revoke its access to my Google account at any time from my Google Account’s security
              settings, which immediately stops all further access.
            </p>
          </Sec>

          <Sec section={M.contact}>
            <p className="leading-relaxed text-foreground/90">
              I may update this policy; the date above reflects the latest version. See also the{' '}
              <Link to="/terms" className="text-accent-cool hover:underline">
                Terms of Service
              </Link>
              . Questions can go through{' '}
              <Link to="/contact" search={{ from: 'privacy' }} className="text-accent-cool hover:underline">
                the contact form
              </Link>
              .
            </p>
          </Sec>
        </LongformDoc>
      </div>
    </main>
  )
}
