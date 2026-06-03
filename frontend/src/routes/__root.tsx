import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import * as React from 'react'

import { DevStateSwitcher } from '~/components/dev/DevStateSwitcher'
import { NotFound } from '~/components/NotFound'
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary'
import appCss from '~/styles/app.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Career Pilot' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: RouteErrorBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* One root MotionConfig so EVERY motion/react animation respects
            prefers-reduced-motion (the structural guarantee — §24.36 36.4); the
            CSS reset in app.css covers CSS animations + transitions. */}
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
        {/* Dev-only async-state switcher (§24.36 36.1). Gated on `import.meta.env.DEV`
            so Rollup tree-shakes it from the production bundle. */}
        {import.meta.env.DEV ? <DevStateSwitcher /> : null}
        <Scripts />
      </body>
    </html>
  )
}
