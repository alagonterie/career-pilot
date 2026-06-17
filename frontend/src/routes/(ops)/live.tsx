import { createFileRoute, redirect } from '@tanstack/react-router'

// Permanent redirect: the ops dashboard lived at /live before the §24.77 rename
// to "Dashboard" (/dashboard). Old links (bookmarks, /pipeline drawer "Live
// activity →" deep-links from pre-rename sessions) land here; the ?app= filter
// param is carried so deep-links keep scoping the trace stream to one app.
export const Route = createFileRoute('/(ops)/live')({
  validateSearch: (search: Record<string, unknown>): { app?: string } => ({
    app: typeof search.app === 'string' && search.app.length > 0 ? search.app : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/dashboard', search, replace: true })
  },
  component: () => null,
})
