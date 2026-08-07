import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { StandbyPage } from '~/components/StandbyPage'
import { isStandbyExempt, type StandbySnapshot, type StandbyState } from '~/lib/standby'

/**
 * The standby gate (§24.189 D6) — wraps both register layouts.
 *
 * While the site is on standby the GCP VM is stopped, so every backend-fed surface
 * (`/work`, the footer socials, `/contact`, the whole ops register) would degrade
 * to committed placeholders and dead forms. Rather than serve a half-working site
 * that quietly lies, standby renders ONE deliberate page at every public route.
 *
 * The exemptions (`isStandbyExempt`) are the edge console — which must work with
 * the VM stopped, that being the entire point — and the static legal pages.
 *
 * Fails OPEN: anything other than an affirmative `standby` renders the normal site,
 * so a KV hiccup can never black out a live public site.
 */
export function StandbyGate({
  state,
  snapshot,
  children,
}: {
  state: StandbyState
  snapshot: StandbySnapshot | null
  children: ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  if (state.mode !== 'standby' || isStandbyExempt(pathname)) return <>{children}</>
  return <StandbyPage state={state} snapshot={snapshot} />
}
