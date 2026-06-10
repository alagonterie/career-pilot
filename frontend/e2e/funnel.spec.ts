import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /pipeline reads the built GET /api/funnel through a polling hook and renders the
// stage board from the deterministic funnel seed (scripts/portal-e2e-server.ts
// → seedDeterministicFunnel). Correctness rests on semantic assertions + a11y +
// the console/network gate; the live stage-advance motion is dev-only.
function ignorable(url: string): boolean {
  // The funnel poll + the landing SSE stream are aborted on nav/teardown —
  // those aborts are expected, not failures.
  return url.includes('/api/funnel') || url.includes('/api/activity/stream')
}

test.describe('/pipeline — the funnel board, frontend <-> backend', () => {
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

    await page.goto('/pipeline')

    await expect(page.getByRole('heading', { level: 1, name: 'Job Pipeline' })).toBeVisible()

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
    // §24.58: an open dialog scroll-locks the page behind it (the shared
    // useDialog contract), and closing restores it.
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(panel).toBeHidden()
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('visible')

    // Accessibility — recruiter-facing showcase; zero violations on every route.
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the detail drawer traps focus and restores it to the card on close (§24.36 36.2)', async ({ page }) => {
    await page.goto('/pipeline')

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

  test('closing the drawer preserves the scroll position (§24.58 Δ)', async ({ page }) => {
    await page.goto('/pipeline')
    await expect(page.getByTestId('funnel-card').first()).toBeVisible()
    // Force a scrollable page on the desktop viewport, then scroll down.
    await page.setViewportSize({ width: 1280, height: 400 })
    await page.evaluate(() => window.scrollTo(0, 300))
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(250)

    await page.getByText('Wayne Enterprises').click()
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeHidden()
    // The visitor stays where they were — not thrown back to the top.
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(250)
  })

  test('browser/OS back dismisses the open drawer in place (§24.58 Δ)', async ({ page }) => {
    await page.goto('/pipeline')
    await page.getByText('Wayne Enterprises').click()
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    await expect(page).toHaveURL(/\?app=/)

    await page.goBack()
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeHidden()
    await expect(page).toHaveURL('/pipeline')
    // Still on the board — back dismissed the overlay, not the page.
    await expect(page.getByTestId('funnel-board')).toBeVisible()
  })

  test('/momentum redirects to /pipeline, ?app preserved (§24.59)', async ({ page }) => {
    // Pre-rename links (bookmarks, old /live outcome deep-links) keep working.
    await page.goto('/momentum?app=Wayne%20Enterprises')
    await expect(page).toHaveURL(/\/pipeline\?app=Wayne([+ ]|%20)Enterprises/)
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    await page.goto('/momentum')
    await expect(page).toHaveURL('/pipeline')
    await expect(page.getByRole('heading', { level: 1, name: 'Job Pipeline' })).toBeVisible()
  })

  test('?app deep-link opens the drawer once the funnel loads (§24.57)', async ({ page }) => {
    await page.goto('/pipeline?app=Wayne%20Enterprises')
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    // An unknown ref is a no-op — the board renders, no drawer.
    await page.goto('/pipeline?app=not-a-real-ref')
    await expect(page.getByTestId('funnel-card').first()).toBeVisible()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('the shared header nav reaches /pipeline and back', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })

    await nav.getByRole('link', { name: 'Job Pipeline' }).click()
    await expect(page).toHaveURL('/pipeline')
    await expect(page.getByRole('heading', { level: 1, name: 'Job Pipeline' })).toBeVisible()

    await nav.getByRole('link', { name: 'Jane Doe' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('live-indicator')).toBeVisible()
  })
})
