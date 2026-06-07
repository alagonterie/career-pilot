import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /live composes the funnel + architecture data + the SSE trace + /api/telemetry
// into the aggregate ops dashboard (§24.29). The E2E server seeds the backlog,
// funnel, sessions, and a fixed container count; the telemetry/cost panels render
// from the seeded per-turn rows (§24.47 — local-sourced, no Portkey API).
// Correctness rests on semantic assertions + a11y + the console/network gate; the
// live-tail (a new pushed row) is already covered by smoke.spec.
function ignorable(url: string): boolean {
  return (
    url.includes('/api/architecture') ||
    url.includes('/api/system-status') ||
    url.includes('/api/funnel') ||
    url.includes('/api/telemetry') ||
    url.includes('/api/activity/stream')
  )
}

test.describe('/live — aggregate ops dashboard, frontend <-> backend', () => {
  test('renders every panel + the trace stream + a working filter chip from the seeded API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => {
      if (ignorable(req.url())) return
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
    })

    await page.goto('/live')

    await expect(page.getByRole('heading', { level: 1, name: 'Live' })).toBeVisible()

    // System status: seeded live_mode=true, pause_state=active (scoped to the
    // mode banner — "Live"/"Active" also appear in the nav, headings, and panels).
    const banner = page.getByTestId('arch-mode-banner')
    await expect(banner.getByText('LIVE', { exact: true })).toBeVisible()
    await expect(banner.getByText('ACTIVE', { exact: true })).toBeVisible()

    // Container pool: fixed PORTAL_MOCK_CONTAINERS=2 of capacity 4.
    await expect(page.getByText('2 / 4')).toBeVisible()

    // Telemetry is local-sourced from the seeded turn row (§24.47): the LLM
    // telemetry panel shows the top model; cache lives in the Cost & cache panel.
    await expect(page.getByText('top model:')).toBeVisible()
    await expect(page.getByText(/of prompt tokens served from cache/)).toBeVisible()

    // The trace stream replays the seeded backlog over SSE.
    const trace = page.getByTestId('trace-stream')
    await expect(trace).toBeVisible()
    await expect(trace.getByText('research-company')).toBeVisible()

    // The compact funnel reveals the public OFFER by its real name (the reveal
    // tier — a public application's ref is the company, not the obfuscated label).
    await expect(page.getByTestId('funnel-compact-reveal')).toContainText('Wayne Enterprises')

    // §24.35 Pass B: the anonymization demo moved off /live into the
    // /architecture pub-sanitize node modal — covered by architecture.spec.ts.

    // §24.34/§24.35 Pass C: the per-turn (category='turn') row renders as a
    // batch-sealing separator carrying the real metrics (model from model_used),
    // not a peer action line.
    await expect(trace.getByTestId('trace-turn')).toContainText('opus-4-8')
    // COST & CACHE shows the est spend summed over the turn rows (§24.47); the
    // "est" qualifier now lives in the metric label, so the value is just "$0.06".
    await expect(page.getByTestId('local-spend')).toHaveText('$0.06')

    // A filter chip narrows the stream: System = non-subagent events only, so the
    // single research-company line disappears.
    await expect(page.getByTestId('trace-line').filter({ hasText: 'research-company' })).toHaveCount(1)
    await page.getByTestId('trace-chip-system').click()
    await expect(page.getByTestId('trace-line').filter({ hasText: 'research-company' })).toHaveCount(0)

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the shared header nav reaches /live and back', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })

    await nav.getByRole('link', { name: 'Live' }).click()
    await expect(page).toHaveURL('/live')
    await expect(page.getByRole('heading', { level: 1, name: 'Live' })).toBeVisible()

    await nav.getByRole('link', { name: 'Jane Doe' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('live-indicator')).toBeVisible()
  })

  test('the landing hero CTA crosses into /live', async ({ page }) => {
    await page.goto('/')
    // Scope to the hero (the connective rail also offers a "See it work" deepen).
    await page.getByRole('main').getByRole('link', { name: 'See it work →' }).click()
    await expect(page).toHaveURL('/live')
    await expect(page.getByRole('heading', { level: 1, name: 'Live' })).toBeVisible()
  })

  test('the Momentum panel links into /momentum (contextual nav — §24.35 Pass A)', async ({ page }) => {
    await page.goto('/live')
    // Scope to main; the FUNNEL panel header action is the only "open →" link.
    await page
      .getByRole('main')
      .getByRole('link', { name: /open →/ })
      .click()
    await expect(page).toHaveURL(/\/momentum$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Momentum' })).toBeVisible()
  })
})
