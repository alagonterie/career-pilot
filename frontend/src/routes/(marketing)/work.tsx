import { createFileRoute, redirect } from '@tanstack/react-router'

// Permanent redirect: the candidate page lived at /work before the §24.77 rename
// to "Experience" (/experience). Old links (resume footers, bookmarks) land here.
export const Route = createFileRoute('/(marketing)/work')({
  beforeLoad: () => {
    throw redirect({ to: '/experience', replace: true })
  },
  component: () => null,
})
