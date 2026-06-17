import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Harness-only control plane (scripts/portal-e2e-server.ts). Server-to-server
// POST (Playwright's request context, not the browser) inserts an audit row so
// we can prove the SSE tail delivers a NEW event through the fetch-reader.
const CONTROL_URL = `http://127.0.0.1:${process.env.PORTAL_E2E_CONTROL_PORT ?? 3098}`

test.describe('landing (/) — hero + live ticker, frontend <-> backend', () => {
  test('renders the hero + seeded ticker and live-appends a pushed event', async ({ page, request }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => {
      // The long-lived SSE stream + the funnel poll (the home funnel strip) are
      // aborted on page close — those teardown aborts are expected, not failures.
      if (req.url().includes('/api/activity/stream') || req.url().includes('/api/funnel')) return
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
    })

    await page.goto('/')

    // Hero (SSR-static).
    await expect(page.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeVisible()
    await expect(page.getByTestId('hero-status')).toBeVisible()

    // Ticker shows the seeded backlog from the real portal API over SSE —
    // the new frontend -> backend -> DB round-trip proof. agent_name + the
    // ◆ proactive marker are live (§24.24), not faked.
    const ticker = page.getByTestId('live-ticker')
    await expect(ticker).toContainText('research-company')
    await expect(ticker).toContainText('[fintech-a]')
    await expect(page.getByTestId('proactive-marker').first()).toBeVisible()

    // Live push: emit a brand-new event after load; the 1s tail must deliver
    // it to the open stream and the ticker must append it.
    const res = await request.post(`${CONTROL_URL}/audit`, {
      data: {
        category: 'subagent_progress',
        agent_name: 'draft-outreach',
        proactive: 1,
        summary: 'drafted a follow-up to the recruiter',
      },
    })
    expect(res.ok()).toBe(true)
    await expect(ticker).toContainText('draft-outreach', { timeout: 8000 })

    // Accessibility — recruiter-facing showcase; zero violations on every route.
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    // Correctness gate: nothing logged an error, no (non-teardown) request failed.
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the live-activity ticker links into /dashboard (contextual nav — §24.35 Pass A)', async ({ page }) => {
    await page.goto('/')
    const ticker = page.getByTestId('live-ticker')
    await expect(ticker).toBeVisible()
    await ticker.getByRole('link', { name: /see it all/i }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
  })
})
