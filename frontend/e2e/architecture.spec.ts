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
    await expect(banner.getByText('ACTIVE')).toBeVisible()

    // The honesty legend distinguishes probed from structural.
    await expect(page.getByTestId('arch-legend')).toContainText('Structural — no live probe')

    // The owner actor (the human in the loop) is part of the map.
    await expect(page.getByTestId('arch-node-owner')).toBeVisible()

    // Probed nodes light up (seeded sessions + fixed container count + active);
    // structural nodes carry no health claim.
    await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
    await expect(page.getByTestId('arch-node-cont-runtime')).toHaveAttribute('data-status', 'healthy')
    await expect(page.getByTestId('arch-node-cont-portkey')).toHaveAttribute('data-status', 'structural')

    // Click a node → the side panel opens with live facts, then closes.
    await page.getByTestId('arch-node-cont-runtime').click()
    const panel = page.getByRole('dialog', { name: 'Container runtime' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('2 / 4')).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(panel).toBeHidden()

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
    await page.getByRole('button', { name: /see the sanitizer run/i }).click()
    const modal = page.getByRole('dialog', { name: 'Sanitization' })
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('anon-sanitized')).toContainText('[EMAIL_REDACTED]')
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
