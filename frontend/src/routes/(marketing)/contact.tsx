import { createFileRoute } from '@tanstack/react-router'

import { ContactForm } from '~/components/ContactForm'
import { seo } from '~/lib/seo'

// The conversion sink (PORTAL §5.7 / §2). Marketing register; the shared layout
// supplies the header (and renders no connective rail here — this IS the rail's
// destination). Carries context: ?company/role/from prefill the form so a
// convinced visitor (or a simulator [Talk to me]) converts in one step.
export const Route = createFileRoute('/(marketing)/contact')({
  component: ContactPage,
  validateSearch: (search: Record<string, unknown>): { company?: string; role?: string; from?: string } => ({
    company: typeof search.company === 'string' ? search.company : undefined,
    role: typeof search.role === 'string' ? search.role : undefined,
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
  head: () =>
    seo({
      title: 'Contact — Jane Doe',
      description: 'Reach out — a recruiter contact form that relays straight to me, plus direct paths.',
      path: '/contact',
    }),
})

function ContactPage() {
  const { company, role, from } = Route.useSearch()
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

      <section aria-labelledby="direct-heading" className="mt-12 border-t border-border pt-6">
        <h2 id="direct-heading" className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Or reach me directly
        </h2>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <a href="mailto:hello@example.com" className="text-accent-cool hover:underline">
            hello@example.com
          </a>
          <a href="https://t.me/janedoe" target="_blank" rel="noreferrer" className="text-accent-cool hover:underline">
            Telegram ↗
          </a>
          <a
            href="https://www.linkedin.com/in/janedoe"
            target="_blank"
            rel="noreferrer"
            className="text-accent-cool hover:underline"
          >
            LinkedIn ↗
          </a>
        </div>
      </section>
    </main>
  )
}
