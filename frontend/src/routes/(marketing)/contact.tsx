import { createFileRoute } from '@tanstack/react-router'

import { ContactForm } from '~/components/ContactForm'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import { workProfile } from '~/lib/work-profile'

// The conversion sink (PORTAL §5.7 / §2). Marketing register; the shared layout
// supplies the header (and renders no connective rail here — this IS the rail's
// destination). Carries context: ?company/role/from prefill the form so a
// convinced visitor (or a simulator [Talk to me]) converts in one step.
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
  const { identity } = Route.useLoaderData()
  const hasDirect = Boolean(identity.email || identity.linkedin || identity.github)
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col px-6 py-16">
      <header>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Talk to me</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {from
            ? `You came from the ${from} view — tell me what you’re hiring for and I’ll reply, usually within 24 hours.`
            : 'Tell me what you’re hiring for and I’ll reply, usually within 24 hours.'}
        </p>
      </header>

      <ContactForm company={company} role={role} from={from} />

      {hasDirect ? (
        <section aria-labelledby="direct-heading" className="mt-12 border-t border-border pt-6">
          <h2 id="direct-heading" className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Or reach me directly
          </h2>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {identity.email ? (
              <a href={`mailto:${identity.email}`} className="text-accent-cool hover:underline">
                {identity.email}
              </a>
            ) : null}
            {identity.linkedin ? (
              <a href={identity.linkedin} target="_blank" rel="noreferrer" className="text-accent-cool hover:underline">
                LinkedIn ↗
              </a>
            ) : null}
            {identity.github ? (
              <a href={identity.github} target="_blank" rel="noreferrer" className="text-accent-cool hover:underline">
                GitHub ↗
              </a>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  )
}
