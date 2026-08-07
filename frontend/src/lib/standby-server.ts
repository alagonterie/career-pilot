import { createServerFn } from '@tanstack/react-start'

import { ACTIVE_STATE, type StandbySnapshot, type StandbyState } from './standby'

/**
 * The server-fn boundary for standby (§24.189) — what route loaders import.
 *
 * This module deliberately does NOT import `standby-kv.ts` at the top level. Route
 * layouts are client-reachable, so a static import would pull the
 * `cloudflare:workers` binding into the client bundle and fail the build. The
 * dynamic import lives inside the handler, which the Start plugin replaces with an
 * RPC stub on the client — so the KV module never enters the client graph at all.
 */

export interface StandbyView {
  state: StandbyState
  snapshot: StandbySnapshot | null
}

const LIVE: StandbyView = { state: ACTIVE_STATE, snapshot: null }

/** SSR read of the standby state + entry snapshot for the layout gate + console.
 *  Any failure resolves to LIVE — failing open is the rule throughout standby. */
export const getStandbyView = createServerFn({ method: 'GET' }).handler(async (): Promise<StandbyView> => {
  try {
    const { readStandbyView } = await import('./standby-kv')
    return await readStandbyView()
  } catch {
    return LIVE
  }
})
