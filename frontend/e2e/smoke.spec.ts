import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('home (/) — frontend <-> backend smoke', () => {
  test('renders system-status fetched from the real portal API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) =>
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`),
    )

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Career Pilot' })).toBeVisible()

    // Data comes from GET /api/system-status -> the seeded in-memory DB
    // (live_mode=true is distinctive from the API's default false, proving
    // this is a real frontend -> backend -> DB round-trip, not empty-state).
    await expect(page.getByTestId('system-status')).toBeVisible()
    await expect(page.getByTestId('backend')).toHaveText('online')
    await expect(page.getByTestId('live-mode')).toHaveText('true')
    await expect(page.getByTestId('pause-state')).toHaveText('active')

    // Accessibility — recruiter-facing showcase; zero violations on every route.
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    // Correctness gate: nothing logged an error, no request failed.
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })
})
