import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /experience is a static SSR shell (no SSE / live-push) rendered from the typed
// WorkProfile placeholder (STRATEGY §24.25). Correctness rests on semantic
// assertions + a11y + the console/network gate.
test.describe('/experience — resume/portfolio shell + shared nav', () => {
  test('renders the resume sections from the read-model placeholder', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => {
      // The landing's SSE stream may still be tearing down from a prior nav.
      if (req.url().includes('/api/activity/stream')) return
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
    })

    await page.goto('/experience')

    await expect(page.getByRole('heading', { level: 1, name: 'Jane Doe' })).toBeVisible()
    for (const heading of [
      'About',
      "What I'm looking for",
      'Experience',
      'Projects',
      'Skills',
      'Education',
      'Elsewhere',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible()
    }
    // Content renders from the placeholder profile (a project + an external link).
    await expect(page.getByText('career-pilot (this portal)')).toBeVisible()
    await expect(page.getByRole('link', { name: 'GitHub' })).toBeVisible()

    // Accessibility — recruiter-facing showcase; zero violations on every route.
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the shared header nav round-trips between / and /experience', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })

    await nav.getByRole('link', { name: 'Experience' }).click()
    await expect(page).toHaveURL('/experience')
    await expect(page.getByRole('heading', { level: 2, name: 'Experience' })).toBeVisible()

    await nav.getByRole('link', { name: 'Jane Doe' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('hero-status')).toBeVisible()
  })
})
