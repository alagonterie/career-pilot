import { createFileRoute, redirect } from '@tanstack/react-router'

// Permanent redirect: the share page lived at /simulator/results/<id> before the
// §24.77 rename to /watch/results/<id>. The most-shared link on the site ("forward
// it to your EM") — the run id is carried so every old share URL still resolves.
export const Route = createFileRoute('/(marketing)/simulator/results/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/watch/results/$id', params, replace: true })
  },
  component: () => null,
})
