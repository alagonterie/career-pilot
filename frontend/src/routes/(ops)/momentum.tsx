import { createFileRoute, redirect } from '@tanstack/react-router'

// Permanent redirect: the pipeline page lived at /momentum before the §24.59
// rename to "Job Pipeline" (/pipeline). Old links (bookmarks, /live outcome
// deep-links from pre-rename sessions) land here; the ?app= drawer param is
// carried so deep-links keep opening the right card.
export const Route = createFileRoute('/(ops)/momentum')({
  validateSearch: (search: Record<string, unknown>): { app?: string } => ({
    app: typeof search.app === 'string' && search.app.length > 0 ? search.app : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/pipeline', search, replace: true })
  },
  component: () => null,
})
