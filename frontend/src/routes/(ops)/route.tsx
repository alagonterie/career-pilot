import { createFileRoute, Outlet } from '@tanstack/react-router'

import { ConnectiveRail } from '~/components/ConnectiveRail'
import { SiteHeader } from '~/components/SiteHeader'

// The operations-register shared layout (PORTAL §3.5 rule 1 / §8.4). A route.tsx
// in a route-group folder is the layout that wraps the group's children
// (/pipeline, /architecture, /live) — it hosts the shared header + the connective
// rail so no ops page re-rolls the shell or dead-ends. The `(ops)` group adds no
// URL segment, so the children keep their root paths.
export const Route = createFileRoute('/(ops)')({
  component: OpsLayout,
})

function OpsLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <div className="flex-1">
        <Outlet />
      </div>
      <ConnectiveRail />
    </div>
  )
}
