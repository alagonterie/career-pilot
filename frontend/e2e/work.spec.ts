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
    for (const heading of ['About', "What I'm looking for", 'Experience', 'Projects', 'Skills', 'Education']) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible()
    }
    // Content renders from the placeholder profile (a project + an external link).
    await expect(page.getByText('career-pilot (this portal)')).toBeVisible()

    // The shared long-form scaffold (§24.83): a sticky scroll-spy TOC over the
    // résumé. Desktop shows the slim left rail (the mobile chip strip is
    // display:none) — exact name avoids matching the "(quick nav)" one. The
    // "Elsewhere" social section is gone (D4); the footer owns socials now.
    const toc = page.getByRole('navigation', { name: 'On this page', exact: true })
    await expect(toc).toBeVisible()
    await expect(toc.getByRole('button', { name: 'Experience' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Elsewhere' })).toHaveCount(0)

    // Let the scaffold's entrance fade settle before the a11y scan — Axe can catch
    // a transient sub-threshold contrast mid-fade (the established kit-dossier wait).
    await expect(page.getByTestId('experience-dossier')).toHaveCSS('opacity', '1')

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
