import { Turnstile } from '@marsidev/react-turnstile'
import * as React from 'react'

/**
 * Turnstile client island (STRATEGY §24.70 / 9.4a, D5). Renders the invisible
 * widget and exposes its token for the form to attach as `x-turnstile-token`.
 *
 * Three resolutions of `VITE_TURNSTILE_SITE_KEY`:
 *   - unset (local dev + vitest)  → no widget, no gate (the Worker skips verify
 *     too — no secret configured), so forms submit exactly as before.
 *   - the always-pass TEST key (dev deploy, D5) → widget renders for visual/flow
 *     parity but `enforce` is false, so submit is never blocked.
 *   - a real key (prod)           → widget renders and `enforce` gates submit
 *     until a token arrives.
 */

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

// Cloudflare's documented always-pass test site key (public constant).
const TEST_SITE_KEY = '1x00000000000000000000AA'

export interface TurnstileState {
  /** The solved token, or null (still solving / no widget / error). */
  token: string | null
  /** True only with a REAL site key — gate the submit button on `!token` then. */
  enforce: boolean
  /** The widget to render in the form, or null when no site key is configured. */
  widget: React.ReactNode
}

export function useTurnstile(action: string): TurnstileState {
  const [token, setToken] = React.useState<string | null>(null)
  const enforce = !!SITE_KEY && SITE_KEY !== TEST_SITE_KEY
  const widget = SITE_KEY ? (
    <Turnstile
      siteKey={SITE_KEY}
      onSuccess={setToken}
      onError={() => setToken(null)}
      onExpire={() => setToken(null)}
      options={{ appearance: 'interaction-only', action }}
    />
  ) : null
  return { token, enforce, widget }
}
