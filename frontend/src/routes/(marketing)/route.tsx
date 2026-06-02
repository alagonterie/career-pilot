import { createFileRoute, Outlet } from '@tanstack/react-router'

import { ConnectiveRail } from '~/components/ConnectiveRail'
import { SiteHeader } from '~/components/SiteHeader'

// The marketing-register shared layout (PORTAL §3.5 rule 1 / §8.4). Wraps `/`,
// `/work`, and `/contact` with the shared header + the connective rail (the rail
// self-renders nothing on `/contact`, the sink). The `(marketing)` group adds no
// URL segment.
export const Route = createFileRoute('/(marketing)')({
  component: MarketingLayout,
})

function MarketingLayout() {
  return (
    <>
      <SiteHeader />
      <Outlet />
      <ConnectiveRail />
    </>
  )
}
