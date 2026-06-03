import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'
import { NotFound } from '~/components/NotFound'
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary'

// TanStack Start v1 convention: the framework's server-entry imports
// `getRouter` from `src/router.tsx`.
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    // A render throw in any leaf route renders the boundary inside that route's
    // parent layout `<Outlet/>` (header + rail persist) — never a chromeless page
    // (§24.36 36.3).
    defaultErrorComponent: RouteErrorBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  })
}
