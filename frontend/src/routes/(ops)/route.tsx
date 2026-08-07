import { createFileRoute, Outlet } from '@tanstack/react-router'

import { ConnectiveRail } from '~/components/ConnectiveRail'
import { SiteFooter } from '~/components/SiteFooter'
import { SiteHeader } from '~/components/SiteHeader'
import { StandbyGate } from '~/components/StandbyGate'
import { getIdentity } from '~/lib/profile-loader'
import { getStandbyView } from '~/lib/standby-server'

// The operations-register shared layout (PORTAL §3.5 rule 1 / §8.4 / §8.2). A
// route.tsx in a route-group folder is the layout that wraps the group's children
// (/pipeline, /architecture, /live, /kit, …) — it hosts the shared header, the
// connective rail, and the sitewide footer so no ops page re-rolls the shell or
// dead-ends. The footer's socials come from the SSR'd identity, loaded here because
// the footer lives in the layout, not a page. The `(ops)` group adds no URL segment.
//
// §24.189: the standby gate lives here too. Every page in this register reads the
// live system, so with the VM stopped they'd all render "offline" — standby shows
// the one deliberate page instead. `/admin/standby` is the load-bearing exemption:
// the edge console has to work precisely when the origin doesn't.
export const Route = createFileRoute('/(ops)')({
  loader: async () => {
    const [identity, standby] = await Promise.all([getIdentity(), getStandbyView()])
    return { identity, standby }
  },
  component: OpsLayout,
})

function OpsLayout() {
  const { identity, standby } = Route.useLoaderData()
  return (
    <StandbyGate state={standby.state} snapshot={standby.snapshot}>
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <div className="flex-1">
          <Outlet />
        </div>
        <ConnectiveRail />
        <SiteFooter identity={identity} />
      </div>
    </StandbyGate>
  )
}
