import { createFileRoute, notFound } from '@tanstack/react-router'

// Mock-only synthetic-crash seam (STRATEGY §24.36 36.3) — the client-side
// counterpart to the server's PORTAL_MOCK_STATE_SEAM. An *unexpected render
// throw* is otherwise unreachable in tests, so this route throws on demand to
// let the E2E + the visual baseline reach the RouteErrorBoundary. Armed by
// `vite dev` (the dev:mock path) or the E2E build's VITE_MOCK_SEAM=1; the
// production build arms neither, so the route is a harmless 404. It lives under
// `(ops)` on purpose — the throw renders inside the ops layout `<Outlet/>`,
// proving the header + rail persist (a crash is never a chromeless page).
const SEAM_ARMED = import.meta.env.DEV || import.meta.env.VITE_MOCK_SEAM === '1'

export const Route = createFileRoute('/(ops)/crash')({
  component: CrashRoute,
})

function CrashRoute(): never {
  if (!SEAM_ARMED) throw notFound()
  throw new Error('Synthetic render error — the mock crash seam (§24.36 36.3).')
}
