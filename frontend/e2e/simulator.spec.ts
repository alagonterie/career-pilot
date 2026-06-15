import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /simulator is the grippiest spoke of the conversion spine (§24.31). The E2E
// server enables PORTAL_MOCK_SIMULATOR, so POST /api/simulator runs a scripted,
// container-free run and the live trace/chat/end stream drives the real UI end
// to end. The mid-run view is timing-dependent (no visual baseline — that's the
// semantic assertions below); the static input + the seeded share page carry the
// visual baselines. The 503/unavailable fallback is unit-tested.

function gate(
  page: import('@playwright/test').Page,
  ignore: RegExp[] = [],
): { consoleErrors: string[]; failedRequests: string[] } {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    if (ignore.some((re) => re.test(msg.text()))) return
    consoleErrors.push(msg.text())
  })
  const failedRequests: string[] = []
  page.on('requestfailed', (req) => {
    // The run aborts its own SSE stream on completion + polling aborts on nav;
    // those are expected /api/ request cancellations, not failures.
    if (req.url().includes('/api/')) return
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
  })
  return { consoleErrors, failedRequests }
}

test.describe('/simulator — the recruiter simulator, frontend <-> backend', () => {
  test('input → live run → results, with a context-carrying Talk to me', async ({ page }) => {
    const { consoleErrors, failedRequests } = gate(page)

    await page.goto('/simulator')
    await expect(page.getByRole('heading', { level: 1, name: /watch me apply to your role/i })).toBeVisible()
    // The simulator page carries no generic connective rail (its own results CTAs
    // are the next step).
    await expect(page.getByTestId('connective-rail')).toHaveCount(0)

    // Fill + run. The button is server-rendered, so a click landing before React
    // hydrates the form is dropped (onClick isn't attached yet) and the run never
    // starts — a pre-existing hydration race. Retry the trigger until the run is
    // observably underway; the early-return makes the retry a no-op once it is
    // (and the final successful fill is what seeds the run's company/role).
    await expect(async () => {
      if (await page.getByTestId('sim-activity').isVisible()) return
      await page.getByLabel('Company name').fill('Wayne Enterprises')
      await page.getByLabel('Role / title').fill('Principal Engineer')
      await page.getByRole('button', { name: /watch me apply/i }).click()
      // The live trace streams in (proof it's a real run, not a screencast).
      await expect(page.getByTestId('sim-activity')).toBeVisible({ timeout: 2000 })
    }).toPass({ timeout: 15_000 })
    await expect(page.getByTestId('sim-trace-subagent').first()).toBeVisible()

    // The run completes → the gift-first results. The pitch (bullets + outreach)
    // shows by default when there's no tailored résumé (the mock run); the run
    // activity is tucked into a collapsed section that expands on demand.
    await expect(page.getByTestId('sim-results')).toBeVisible()
    await expect(page.getByTestId('sim-output-body')).toContainText('Tailored resume')
    await expect(page.getByTestId('sim-output-body')).toContainText('Cold outreach')
    await page.getByTestId('result-activity-toggle').click()
    await expect(page.getByTestId('sim-trace-complete')).toBeVisible()

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])

    // The conversion loop closes: Talk to me carries the run's company + the from.
    await page.getByTestId('sim-talk').click()
    await expect(page).toHaveURL(/\/contact\?/)
    await expect(page).toHaveURL(/from=simulator/)
    await expect(page).toHaveURL(/company=Wayne/)
  })

  test('the share page renders a seeded run and handles an expired one', async ({ page }) => {
    // The expired-run probe below deliberately requests a missing id → the
    // browser's 404 resource message is the expected artifact, not a real error.
    const { consoleErrors, failedRequests } = gate(page, [/status of 404/])

    await page.goto('/simulator/results/det-sim-1')
    await expect(page.getByRole('heading', { level: 1, name: /Principal Engineer @ Wayne Enterprises/i })).toBeVisible()
    await expect(page.getByTestId('sim-output-body')).toContainText('Tailored resume')
    await expect(page.getByTestId('share-talk')).toBeVisible()

    // The persisted run activity, collapsed by default, expands on demand (§24.31 Δ).
    const toggle = page.getByTestId('result-activity-toggle')
    await expect(toggle).toContainText(/see how this run worked/i)
    await expect(page.getByTestId('sim-activity')).toHaveCount(0)
    await toggle.click()
    await expect(page.getByTestId('sim-activity')).toBeVisible()
    await expect(page.getByTestId('sim-trace-subagent').first()).toContainText('research-company')

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    // A missing/expired id → the honest "run your own" state.
    await page.goto('/simulator/results/does-not-exist')
    await expect(page.getByTestId('share-missing')).toBeVisible()

    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the rail, the nav, and the home pitch all reach /simulator', async ({ page }) => {
    // The /live rail's pivot → /simulator.
    await page.goto('/live')
    await page
      .getByTestId('connective-rail')
      .getByRole('link', { name: /run it on your role/i })
      .click()
    await expect(page).toHaveURL('/simulator')
    await expect(page.getByRole('heading', { level: 1, name: /watch me apply to your role/i })).toBeVisible()

    // The top nav reaches it.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Watch it work' }).click()
    await expect(page).toHaveURL('/simulator')

    // The home Viewport-4 pitch CTA reaches it.
    await page.goto('/')
    await page
      .getByRole('main')
      .getByRole('link', { name: /watch me apply to your role/i })
      .click()
    await expect(page).toHaveURL('/simulator')
  })
})
