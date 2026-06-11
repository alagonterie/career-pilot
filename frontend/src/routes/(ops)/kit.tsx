import { createFileRoute, Link } from '@tanstack/react-router'

import { KitDossier } from '~/components/kit/KitDossier'
import { StateNote } from '~/components/states'
import { seo } from '~/lib/seo'
import { kitDate, roundLabel, useKit } from '~/lib/use-kit'

// The interview-kit dossier (PORTAL §5.9 / STRATEGY §24.65). Reached from the
// /pipeline drawer's "Interview prep" rows; `?app=«ref»&round=«round»` mirrors
// the established deep-link convention. Browser back lands on
// `/pipeline?app=«ref»`, which re-opens the drawer (URL-as-source-of-truth) —
// the navigation-stack feel with zero new dialog code.
export const Route = createFileRoute('/(ops)/kit')({
  component: KitPage,
  validateSearch: (search: Record<string, unknown>): { app?: string; round?: string } => ({
    app: typeof search.app === 'string' && search.app.length > 0 ? search.app : undefined,
    round: typeof search.round === 'string' && search.round.length > 0 ? search.round : undefined,
  }),
  head: () =>
    seo({
      title: 'Interview kit — Jane Doe',
      description:
        'A real mock-interview kit built by the agent — sections that would identify the company stay sealed while the process is live.',
      path: '/kit',
    }),
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function KitSkeleton() {
  return (
    <div data-testid="kit-skeleton" aria-hidden="true" className="mt-8 space-y-3">
      <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <div className="mt-6 h-3 w-5/6 animate-pulse rounded bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
    </div>
  )
}

function KitPage() {
  const { app, round } = Route.useSearch()
  const { data: kit, status } = useKit(API_BASE, app, round)

  const isPublic = kit?.public_state === 'public'
  const title = kit ? (isPublic ? kit.application_ref : `[${kit.application_ref}]`) : ''

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-12">
      <Link
        to="/pipeline"
        search={app ? { app } : {}}
        data-testid="kit-back-link"
        className="self-start font-mono text-xs text-accent-cool hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ← Job Pipeline
      </Link>

      {status === 'loading' ? (
        <KitSkeleton />
      ) : status === 'error' ? (
        <div className="flex min-h-[16rem] items-center justify-center">
          <StateNote data-testid="kit-error" tone="error">
            The kit is offline — try again shortly.
          </StateNote>
        </div>
      ) : status === 'missing' || !kit ? (
        <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3">
          <StateNote data-testid="kit-missing">
            No interview kit here — it may have moved with its application.
          </StateNote>
          <Link to="/pipeline" className="font-mono text-xs text-accent-cool hover:underline">
            Back to the pipeline →
          </Link>
        </div>
      ) : (
        <>
          {/* Dossier masthead: the document-style header. */}
          <header data-testid="kit-masthead" className="border-b border-border pb-5">
            <div className="flex items-baseline justify-between gap-4">
              <h1 className="min-w-0 truncate font-mono text-2xl font-bold tracking-tight">{title}</h1>
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Interview kit
              </span>
            </div>
            {kit.role_title ? <p className="mt-1 text-sm text-muted-foreground">{kit.role_title}</p> : null}
            {isPublic ? <p className="mt-1 font-mono text-xs text-primary">◆ public</p> : null}
            {/* interview_type derives 1:1 from the round — naming both would
                read "Technical screen · technical screen". The round label carries it. */}
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {roundLabel(kit.round)}
              {kit.interview_at ? ` · ${kitDate(kit.interview_at)}` : ''} · {kit.status}
            </p>
          </header>

          {/* Reveal banner: which policy state this dossier is rendered under. */}
          {isPublic ? (
            <p data-testid="kit-banner-public" className="font-mono text-xs leading-relaxed text-primary">
              ◆ revealed post-close — shown in full.
            </p>
          ) : (
            <p data-testid="kit-banner-sealed" className="font-mono text-xs leading-relaxed text-muted-foreground">
              This process is live — sections that would identify the company are sealed. If the process is revealed
              post-close, the kit shows in full.
            </p>
          )}

          {kit.sections.length === 0 ? (
            <div className="flex min-h-[10rem] items-center justify-center">
              <StateNote data-testid="kit-no-content">
                Content not captured for kits built before this feature — the metadata above is the record.
              </StateNote>
            </div>
          ) : (
            <KitDossier kit={kit} />
          )}

          <footer className="mt-4 border-t border-border pt-5 text-[11px] leading-relaxed text-muted-foreground">
            Built by the build-interview-kit subagent the moment this application entered the round. The kit lives as a
            Google Doc in the candidate&apos;s private Drive and is conducted live as a voice mock — this page is its
            public projection.
          </footer>
        </>
      )}
    </main>
  )
}
