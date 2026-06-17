import { createFileRoute, redirect } from '@tanstack/react-router'

// Permanent redirect: "Watch it work" lived at /simulator before the §24.77
// rename to /watch (dropping "simulator" from URLs). Old links land here.
export const Route = createFileRoute('/(marketing)/simulator/')({
  beforeLoad: () => {
    throw redirect({ to: '/watch', replace: true })
  },
  component: () => null,
})
