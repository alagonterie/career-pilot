import { createFileRoute } from '@tanstack/react-router'

import { WorkSections } from '~/components/work/sections'
import { getWorkProfile } from '~/lib/profile-loader'
import { seo } from '~/lib/seo'
import { workProfile } from '~/lib/work-profile'

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

function Work() {
  // SSR-rendered from the live `candidate_profile` (via /api/profile); falls back
  // to the typed `workProfile` placeholder when no profile is composed yet.
  const { profile } = Route.useLoaderData()
  const p = profile ?? workProfile
  return (
    <>
      <main className="mx-auto flex max-w-3xl flex-col items-start px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{p.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{p.title}</p>
        <div className="mt-12 w-full">
          <WorkSections profile={p} />
        </div>
      </main>
    </>
  )
}
