import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /architecture reads GET /api/architecture + /api/system-status through a
// polling hook and draws the SVG system map. The E2E server seeds deterministic
// sessions + a fixed PORTAL_MOCK_CONTAINERS + the system modes, so every status
// badge is deterministic (§24.28). Correctness rests on semantic assertions +
// a11y + the console/network gate; the dot-pulse is dev-only.
function ignorable(url: string): boolean {
  return (
    url.includes('/api/architecture') ||
    url.includes('/api/system-status') ||
    url.includes('/api/observability') ||
    url.includes('/api/activity/stream') ||
    url.includes('/api/sanitize-demo')
  )
}

test.describe('/architecture — live system map, frontend <-> backend', () => {
  // Freeze motion's reduced-motion branch so the node grow-into-modal is instant
  // and deterministic (§24.35 Pass B); the grow is verified manually via the MCP.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('renders the map + honest status badges + the node panel from the seeded API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => {
      if (ignorable(req.url())) return
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
    })

    await page.goto('/architecture')

    await expect(page.getByRole('heading', { level: 1, name: 'Architecture' })).toBeVisible()

    // The diagram renders from the polled endpoints.
    await expect(page.getByTestId('arch-diagram')).toBeVisible()

    // Mode banner: seeded live_mode=true, pause_state=active.
    const banner = page.getByTestId('arch-mode-banner')
    await expect(banner.getByText('LIVE')).toBeVisible()
    await expect(banner.getByText('RUNNING')).toBeVisible() // §24.69 — pause_state 'active' → RUNNING

    // The honesty legend distinguishes probed from structural.
    await expect(page.getByTestId('arch-legend')).toContainText('Structural — no live probe')

    // The owner actor (the human in the loop) is part of the map.
    await expect(page.getByTestId('arch-node-owner')).toBeVisible()

    // Probed nodes light up (seeded sessions + fixed container count + active).
    // §24.69: the integration nodes now light from request telemetry too — the
    // E2E seed gives Portkey a recent success → healthy (was structural).
    await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
    await expect(page.getByTestId('arch-node-cont-runtime')).toHaveAttribute('data-status', 'healthy')
    await expect(page.getByTestId('arch-node-cont-portkey')).toHaveAttribute('data-status', 'healthy')
    // cont-anthropic stays honestly structural (we probe the gateway, not Anthropic).
    await expect(page.getByTestId('arch-node-cont-anthropic')).toHaveAttribute('data-status', 'structural')

    // Click a node → the side panel opens with live facts, then closes.
    await page.getByTestId('arch-node-cont-runtime').click()
    const panel = page.getByRole('dialog', { name: 'Container runtime' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('2 / 4')).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(panel).toBeHidden()

    // §24.69: the Portkey node modal carries aggregate provider facts (no raw
    // error text — the §9 boundary), and the Orchestrator modal shows topology.
    await page.getByTestId('arch-node-cont-portkey').click()
    const portkey = page.getByRole('dialog', { name: 'Portkey gateway' })
    await expect(portkey).toBeVisible()
    await expect(portkey.getByText('Requests 24h')).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()

    await page.getByTestId('arch-node-cont-orch').click()
    const orch = page.getByRole('dialog', { name: 'Orchestrator' })
    await expect(orch).toBeVisible()
    await expect(orch.getByText('By class')).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()

    // The "what you're looking at" panel links into the repo.
    await expect(page.getByRole('link', { name: /README/ })).toBeVisible()

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the pub-sanitize node opens a modal with the live anonymization demo (§24.35 Pass B)', async ({ page }) => {
    await page.goto('/architecture')
    await page.getByTestId('arch-node-pub-sanitize').click()
    const modal = page.getByRole('dialog', { name: 'Sanitization' })
    await expect(modal).toBeVisible()
    // The real sanitizer over a synthetic sample: markers present, synthetic company redacted.
    await expect(modal.getByTestId('anon-sanitized')).toContainText('[EMAIL_REDACTED]')
    await expect(modal.getByTestId('anon-sanitized')).toContainText('[REDACTED:saas-demo]')
    await expect(modal.getByTestId('anon-raw')).toContainText('Globex')
    await expect(modal.getByTestId('anon-sanitized')).not.toContainText('Globex')

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(modal).toBeHidden()
  })

  test('the "see the sanitizer run" explainer control opens the sanitizer modal', async ({ page }) => {
    await page.goto('/architecture')
    // Gate on a probed status badge: it only reflects the polled data once React
    // has hydrated, so by here the explainer button's onClick is live. Clicking
    // the SSR-rendered button before hydration drops the open (a pre-existing
    // race, surfaced while adding the §24.36 36.2 focus test below).
    await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
    await page.getByRole('button', { name: /see the sanitizer run/i }).click()
    const modal = page.getByRole('dialog', { name: 'Sanitization' })
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('anon-sanitized')).toContainText('[EMAIL_REDACTED]')
  })

  test('the node modal traps focus and restores it to the node on close (§24.36 36.2)', async ({ page }) => {
    await page.goto('/architecture')

    // Gate on hydration before keyboard-activating the node — the SSR-rendered
    // node buttons are clickable before React attaches onClick, so activating
    // pre-hydration would drop the open (same race as the explainer test above).
    const trigger = page.getByTestId('arch-node-cont-runtime')
    await expect(trigger).toHaveAttribute('data-status', 'healthy')
    await trigger.focus()
    await page.keyboard.press('Enter')

    const panel = page.getByRole('dialog', { name: 'Container runtime' })
    await expect(panel).toBeVisible()
    await expect(panel).toBeFocused()

    // Tab through every stop — focus must stay on a descendant of the dialog,
    // never escaping to the (now inert) page behind it.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      await expect(panel.locator(':focus')).toHaveCount(1)
    }

    // Escape closes and focus returns to the triggering node.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('an unexpected render error degrades to a recoverable boundary inside the shell (§24.36 36.3)', async ({
    page,
  }) => {
    // The mock-only /crash route throws during render (VITE_MOCK_SEAM is armed in
    // the E2E build). React logs the caught error to the console by design, so
    // this test deliberately uses no console gate.
    await page.goto('/crash')

    const boundary = page.getByTestId('route-error')
    await expect(boundary).toBeVisible()
    await expect(boundary.getByText(/ran into a problem/i)).toBeVisible()
    await expect(boundary.getByTestId('route-error-retry')).toBeVisible()
    await expect(boundary.getByRole('link', { name: /go home/i })).toHaveAttribute('href', '/')

    // The boundary renders inside the ops layout `<Outlet/>` — the header
    // persists, so a crash is never a chromeless dead-end (the visitor can still
    // navigate away). The connective rail is correctly absent (an unmapped route).
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()

    // No raw stack is shown to visitors (the production build hides the detail).
    await expect(page.getByTestId('route-error-detail')).toHaveCount(0)

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
  })

  test('the shared header nav reaches /architecture and back', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })

    await nav.getByRole('link', { name: 'Architecture' }).click()
    await expect(page).toHaveURL('/architecture')
    await expect(page.getByRole('heading', { level: 1, name: 'Architecture' })).toBeVisible()

    await nav.getByRole('link', { name: 'Jane Doe' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('live-indicator')).toBeVisible()
  })
})
