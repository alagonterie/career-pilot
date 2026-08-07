import { createFileRoute, Outlet } from '@tanstack/react-router'

import { ConnectiveRail } from '~/components/ConnectiveRail'
import { SiteFooter } from '~/components/SiteFooter'
import { SiteHeader } from '~/components/SiteHeader'
import { StandbyGate } from '~/components/StandbyGate'
import { getIdentity } from '~/lib/profile-loader'
import { getStandbyView } from '~/lib/standby-server'

// The marketing-register shared layout (PORTAL §3.5 rule 1 / §8.4 / §8.2). Wraps
// `/`, `/experience`, `/about`, `/contact`, and `/watch` with the shared header, the
// connective rail (self-renders nothing on the unmapped surfaces), and the sitewide
// footer. The footer's socials come from the SSR'd identity, loaded here because the
// footer lives in the layout, not a page. The `(marketing)` group adds no URL segment.
//
// §24.189: the layout also carries the standby gate. When the search is on standby
// the VM is stopped, so this whole register renders the single standby page instead
// of a shell whose every panel would read "offline".
export const Route = createFileRoute('/(marketing)')({
  loader: async () => {
    const [identity, standby] = await Promise.all([getIdentity(), getStandbyView()])
    return { identity, standby }
  },
  component: MarketingLayout,
})

function MarketingLayout() {
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
