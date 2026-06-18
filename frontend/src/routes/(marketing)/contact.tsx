import { createFileRoute } from '@tanstack/react-router'

import { AvailabilityBadge } from '~/components/AvailabilityBadge'
import { ContactForm } from '~/components/ContactForm'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import { useActivityStream } from '~/lib/use-activity-stream'
import { workProfile } from '~/lib/work-profile'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

// The conversion sink (PORTAL §5.7 / §2). Marketing register; the shared layout
// supplies the header (and renders no connective rail here — this IS the rail's
// destination). Carries context: ?company/role/from prefill the form so a
// convinced visitor (or a [Talk to me] from a Watch-it-work run) converts in one step.
export const Route = createFileRoute('/(marketing)/contact')({
  component: ContactPage,
  // SSR loader (§24.71 9.4b-3): the candidate's canonical identity drives the
  // "reach me directly" paths — no hardcoded placeholder links.
  loader: () => getWorkProfile(),
  validateSearch: (search: Record<string, unknown>): { company?: string; role?: string; from?: string } => ({
    company: typeof search.company === 'string' ? search.company : undefined,
    role: typeof search.role === 'string' ? search.role : undefined,
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
  head: ({ loaderData }) =>
    seo({
      title: `Contact — ${loaderData?.profile?.name ?? workProfile.name}`,
      description: 'Reach out — a recruiter contact form that relays straight to me, plus direct paths.',
      path: '/contact',
    }),
})

function ContactPage() {
  const { company, role, from } = Route.useSearch()
  // §24.120: the conversion sink breathes like the rest of the site — the same
  // "Open to offers" live-pulse pill as the home hero (pulses while the activity
  // feed is connected). Status only; the contact page doesn't render the events.
  const { status } = useActivityStream(API_BASE)
  // No "reach me directly" block (§24.83 D4/D5): the form IS the email relay, and
  // the sitewide footer carries the socials — a per-page social list duplicated it
  // and the plain-text email was a scraping leak the footer deliberately avoids.
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col px-6 py-16">
      <div className="mb-6 flex justify-center">
        <AvailabilityBadge
          status={status}
          data-testid="contact-status"
          title={status === 'open' ? 'open to offers — live' : 'open to offers'}
        />
      </div>
      <header>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Talk to me</h1>
        {/* §24.120 — the instant-to-phone hook: surface the true, delightful fact
            that a submission reaches my phone in seconds (a host-delivered relay). */}
        <p className="mt-2 text-sm text-muted-foreground">
          {from
            ? `You came from the ${from} view — tell me what you’re hiring for. It goes straight to my phone, and I’ll reply, usually within 24 hours.`
            : 'Tell me what you’re hiring for — it goes straight to my phone, and I’ll reply, usually within 24 hours.'}
        </p>
      </header>

      <ContactForm company={company} role={role} from={from} />
    </main>
  )
}
