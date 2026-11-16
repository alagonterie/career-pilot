import { Turnstile } from '@marsidev/react-turnstile'
import type { TurnstileInstance } from '@marsidev/react-turnstile'
import * as React from 'react'

/**
 * Turnstile client island (STRATEGY §24.70 / 9.4a, D5; status + reset §24.200).
 * Renders the invisible widget and exposes its token for the form to attach as
 * `x-turnstile-token`.
 *
 * Three resolutions of `VITE_TURNSTILE_SITE_KEY`:
 *   - unset (local dev + vitest)  → no widget, no gate (the Worker skips verify
 *     too — no secret configured), so forms submit exactly as before.
 *   - the always-pass TEST key (dev deploy, D5) → widget renders for visual/flow
 *     parity but `enforce` is false, so submit is never blocked.
 *   - a real key (prod)           → widget renders and `enforce` gates submit
 *     until a token arrives.
 *
 * A token is SINGLE-USE: once a request carrying it reaches siteverify it is
 * spent, whatever the outcome. A form that stays mounted after a failed submit
 * must call `reset()` so the retry carries a fresh one.
 */

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

// Cloudflare's documented always-pass test site key (public constant).
const TEST_SITE_KEY = '1x00000000000000000000AA'

/** `off` = no site key configured; `failed` = the widget's error callback fired. */
export type TurnstileStatus = 'off' | 'solving' | 'ready' | 'failed'

export interface TurnstileState {
  /** The solved token, or null (still solving / no widget / error). */
  token: string | null
  /** True only with a REAL site key — gate the submit button on `!token` then. */
  enforce: boolean
  /** The widget to render in the form, or null when no site key is configured. */
  widget: React.ReactNode
  /** What the widget is doing right now. */
  status: TurnstileStatus
  /** Discard the current token and solve again (call after any failed submit). */
  reset: () => void
  /** A line explaining a blocked submit button — null unless enforcing and not ready. */
  hint: React.ReactNode
}

export function useTurnstile(action: string): TurnstileState {
  const [token, setToken] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  const ref = React.useRef<TurnstileInstance | null>(null)
  const enforce = !!SITE_KEY && SITE_KEY !== TEST_SITE_KEY

  const reset = React.useCallback((): void => {
    setToken(null)
    setFailed(false)
    ref.current?.reset()
  }, [])

  const widget = SITE_KEY ? (
    <Turnstile
      ref={ref}
      siteKey={SITE_KEY}
      onSuccess={(t) => {
        setFailed(false)
        setToken(t)
      }}
      onError={() => {
        setToken(null)
        setFailed(true)
      }}
      onExpire={() => setToken(null)}
      options={{ appearance: 'interaction-only', action }}
    />
  ) : null

  const status: TurnstileStatus = !SITE_KEY ? 'off' : token ? 'ready' : failed ? 'failed' : 'solving'

  // Only under enforcement: with no key / the test key the button is never
  // blocked, so there is nothing to explain.
  const hint =
    enforce && status === 'solving' ? (
      <p data-testid="turnstile-hint" role="status" className="text-xs text-muted-foreground">
        Verifying you’re human…
      </p>
    ) : enforce && status === 'failed' ? (
      <p data-testid="turnstile-hint" role="alert" className="text-xs text-destructive">
        Couldn’t verify your browser. Complete the check if one is shown, or turn off content blockers for this page and
        reload.
      </p>
    ) : null

  return { token, enforce, widget, status, reset, hint }
}
