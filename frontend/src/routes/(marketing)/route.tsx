import { createFileRoute, Outlet } from '@tanstack/react-router'

import { ConnectiveRail } from '~/components/ConnectiveRail'
import { SiteFooter } from '~/components/SiteFooter'
import { SiteHeader } from '~/components/SiteHeader'
import { getIdentity } from '~/lib/profile-loader'

// The marketing-register shared layout (PORTAL §3.5 rule 1 / §8.4 / §8.2). Wraps
// `/`, `/experience`, `/about`, `/contact`, and `/watch` with the shared header, the
// connective rail (self-renders nothing on the unmapped surfaces), and the sitewide
// footer. The footer's socials come from the SSR'd identity, loaded here because the
// footer lives in the layout, not a page. The `(marketing)` group adds no URL segment.
export const Route = createFileRoute('/(marketing)')({
  loader: () => getIdentity(),
  component: MarketingLayout,
})

function MarketingLayout() {
  const identity = Route.useLoaderData()
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <div className="flex-1">
        <Outlet />
      </div>
      <ConnectiveRail />
      <SiteFooter identity={identity} />
    </div>
  )
}
