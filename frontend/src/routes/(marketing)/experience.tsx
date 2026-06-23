import { createFileRoute, Link } from '@tanstack/react-router'

import { AgentMark } from '~/components/AgentMark'
import { ResumeDownload } from '~/components/ResumeDownload'
import { WorkSections } from '~/components/work/sections'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import { workProfile } from '~/lib/work-profile'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

export const Route = createFileRoute('/(marketing)/experience')({
  component: Work,
  // SSR loader (§24.71 / 9.4b-1): the real candidate profile, fetched server-side
  // so it's in the SSR HTML + the meta tags (works JS-disabled, PORTAL §10).
  loader: () => getWorkProfile(),
  head: ({ loaderData }) => {
    const p = loaderData?.profile ?? workProfile
    return seo({
      title: `Experience — ${p.name}`,
      description: `Resume, experience, and projects — ${p.title}.`,
      path: '/experience',
    })
  },
})

/** UTC-fixed date so SSR (Worker) and client render identically (no hydration shift). */
function composedOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function Work() {
  // SSR-rendered from the live `candidate_profile` (via /api/profile); falls back
  // to the typed `workProfile` placeholder when no profile is composed yet.
  const { profile, source, generatedAt } = Route.useLoaderData()
  const p = profile ?? workProfile
  // Download-PDF (§24.72 / 9.4b-r1): server-rendered from the same WorkProfile.
  // Gated on a real composed profile — the backend 404s for a placeholder, so we
  // never offer a download that wouldn't resolve.
  const canDownload = profile != null
  // §24.81 (T3): the shared, progressively-enhanced download control — the
  // "Preparing…" state + server filename + fallback + no-resize behavior of the
  // /watch results gift, in the Experience page's quieter outline/sm register and
  // WITHOUT the preview modal (the page is the résumé already; the button repeats).
  const downloadBtn = (
    <ResumeDownload
      pdfUrl={`${API_BASE}/api/resume.pdf${generatedAt ? `?v=${encodeURIComponent(generatedAt)}` : ''}`}
      fallbackFilename="resume.pdf"
      size="sm"
      variant="outline"
    />
  )
  return (
    <>
      <main className="mx-auto flex max-w-4xl flex-col items-start px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{p.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{p.focus ? `${p.title} · ${p.focus}` : p.title}</p>
        {/* Provenance (§24.71 D4 / §24.73): honest only when the agent actually
            composed this page — a hand-seed (source='seed') or the placeholder
            shows no marker. The master page is whole-system output, so it's
            attributed to the orchestrator, not a single specialist. */}
        {source === 'agent' && generatedAt ? (
          <AgentMark
            actor="orchestrator"
            lead="Composed by"
            trail={`from my master résumé · ${composedOn(generatedAt)}`}
            className="mt-3"
          />
        ) : null}
        {canDownload ? (
          <div className="mt-6 flex flex-col gap-2">
            {downloadBtn}
            {/* Tier-2 cross-sell (§24.72): the "watch me apply" spoke produces a
                role-tailored cut of this résumé, live. The CTA half is nowrap so the
                line breaks between the question and the CTA (never an orphaned →) on
                mobile — §24.88. */}
            <Link to="/watch" className="font-mono text-xs text-accent-cool hover:underline">
              Want one aimed at your role? <span className="whitespace-nowrap">Watch me apply to it →</span>
            </Link>
          </div>
        ) : null}
        <div className="mt-10 w-full">
          <WorkSections profile={p} />
        </div>
        {/* No second, end-of-page download (§24.98, reverses §24.88): the bottom
            button under a border-t read as a bare duplicate that mimicked the
            per-section dividers. The masthead download above is the single
            affordance — the page body already *is* the résumé. */}
      </main>
    </>
  )
}
