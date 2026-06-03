import { createFileRoute } from '@tanstack/react-router'

import { WorkSections } from '~/components/work/sections'
import { seo } from '~/lib/seo'
import { workProfile } from '~/lib/work-profile'

export const Route = createFileRoute('/(marketing)/work')({
  component: Work,
  head: () =>
    seo({
      title: 'Work — Jane Doe',
      description:
        'Resume, experience, and projects — a senior software engineer working in AI Systems and developer experience.',
      path: '/work',
    }),
})

function Work() {
  // SSR-static (works JS-disabled, PORTAL §10). Rendered from the typed
  // `workProfile` placeholder; a future `/api/profile` returns the same shape.
  return (
    <>
      <main className="mx-auto flex max-w-3xl flex-col items-start px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{workProfile.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{workProfile.title}</p>
        <div className="mt-12 w-full">
          <WorkSections profile={workProfile} />
        </div>
      </main>
    </>
  )
}
