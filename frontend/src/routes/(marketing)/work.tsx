import { createFileRoute, Link } from '@tanstack/react-router'

import { Button } from '~/components/ui/button'
import { WorkSections } from '~/components/work/sections'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import { workProfile } from '~/lib/work-profile'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

export const Route = createFileRoute('/(marketing)/work')({
  component: Work,
  // SSR loader (§24.71 / 9.4b-1): the real candidate profile, fetched server-side
  // so it's in the SSR HTML + the meta tags (works JS-disabled, PORTAL §10).
  loader: () => getWorkProfile(),
  head: ({ loaderData }) => {
    const p = loaderData?.profile ?? workProfile
    return seo({
      title: `Work — ${p.name}`,
      description: `Resume, experience, and projects — ${p.title}.`,
      path: '/work',
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
  const downloadBtn = (
    <Button asChild variant="outline" size="sm">
      <a href={`${API_BASE}/api/resume.pdf${generatedAt ? `?v=${encodeURIComponent(generatedAt)}` : ''}`} download>
        Download résumé (PDF) ↓
      </a>
    </Button>
  )
  return (
    <>
      <main className="mx-auto flex max-w-3xl flex-col items-start px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{p.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{p.title}</p>
        {/* Provenance (§24.71 D4): honest only when the agent actually composed
            this page — a hand-seed (source='seed') or the placeholder shows no marker. */}
        {source === 'agent' && generatedAt ? (
          <p className="mt-3 font-mono text-xs text-accent-cool">
            ✦ Composed by my agent from my master resume · {composedOn(generatedAt)}
          </p>
        ) : null}
        {canDownload ? (
          <div className="mt-6 flex flex-col gap-2">
            {downloadBtn}
            {/* Tier-2 cross-sell (§24.72): the simulator produces a role-tailored cut. */}
            <Link to="/simulator" className="font-mono text-xs text-accent-cool hover:underline">
              Want one aimed at your role? Run the 2-minute simulator →
            </Link>
          </div>
        ) : null}
        <div className="mt-10 w-full">
          <WorkSections profile={p} />
        </div>
        {canDownload ? <div className="mt-12">{downloadBtn}</div> : null}
      </main>
    </>
  )
}
