import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /momentum reads the built GET /api/funnel through a polling hook and renders the
// stage board from the deterministic funnel seed (scripts/portal-e2e-server.ts
// → seedDeterministicFunnel). Correctness rests on semantic assertions + a11y +
// the console/network gate; the live stage-advance motion is dev-only.
function ignorable(url: string): boolean {
  // The funnel poll + the landing SSE stream are aborted on nav/teardown —
  // those aborts are expected, not failures.
  return url.includes('/api/funnel') || url.includes('/api/activity/stream')
}

test.describe('/momentum — pipeline board, frontend <-> backend', () => {
  test('renders the stage board + reveal tier + detail panel from the seeded API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => {
      if (ignorable(req.url())) return
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
    })

    await page.goto('/momentum')

    await expect(page.getByRole('heading', { level: 1, name: 'Momentum' })).toBeVisible()

    // Board renders from the seeded /api/funnel over the polling hook.
    const board = page.getByTestId('funnel-board')
    await expect(board).toBeVisible()
    for (const col of ['Applied', 'Screening', 'Tech', 'Final', 'Offer']) {
      await expect(page.getByRole('region', { name: col })).toBeVisible()
    }

    // Reveal tier: obfuscated by default; the public OFFER shows its real name.
    await expect(page.getByText('[fintech-a]')).toBeVisible()
    await expect(page.getByText('Wayne Enterprises')).toBeVisible()
    await expect(page.getByTestId('reveal-marker')).toBeVisible()

    // Click a card → the detail side-panel opens, then closes.
    await page.getByText('Wayne Enterprises').click()
    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText(/AI estimate/i)).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(panel).toBeHidden()

    // Accessibility — recruiter-facing showcase; zero violations on every route.
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the detail drawer traps focus and restores it to the card on close (§24.36 36.2)', async ({ page }) => {
    await page.goto('/momentum')

    // Open from a keyboard-focused card so the trigger is a known element.
    const card = page.getByTestId('funnel-card').filter({ hasText: 'Wayne Enterprises' })
    await card.focus()
    await page.keyboard.press('Enter')

    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()
    // Focus lands in the dialog shell on open.
    await expect(panel).toBeFocused()

    // Tab moves into the dialog's only tabbable (Close), and the trap keeps it
    // there — Tab off the end and Shift+Tab off the top both stay inside.
    const close = panel.getByRole('button', { name: 'Close panel' })
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(close).toBeFocused()

    // Escape closes and focus returns to the triggering card.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(card).toBeFocused()
  })

  test('the shared header nav reaches /momentum and back', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })

    await nav.getByRole('link', { name: 'Momentum' }).click()
    await expect(page).toHaveURL('/momentum')
    await expect(page.getByRole('heading', { level: 1, name: 'Momentum' })).toBeVisible()

    await nav.getByRole('link', { name: 'Jane Doe' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('live-indicator')).toBeVisible()
  })
})
