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
    url.includes('/api/observability') ||
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

    // System status (unboxed header strip): seeded live_mode=true,
    // pause_state=active → "LIVE" + "RUNNING" (§24.69 — "active" reads as RUNNING,
    // not the contradictory "Pause: ACTIVE").
    const banner = page.getByTestId('arch-mode-banner')
    await expect(banner.getByText('LIVE', { exact: true })).toBeVisible()
    await expect(banner.getByText('RUNNING', { exact: true })).toBeVisible()

    // Container pool: fixed PORTAL_MOCK_CONTAINERS=2 of capacity 4.
    await expect(page.getByText('2 / 4')).toBeVisible()

    // Telemetry is local-sourced from the seeded turn row (§24.47): the LLM
    // telemetry panel shows the top model + the cache rate (moved here from the
    // retired Cost & cache box — §24.69; its InfoTip trigger is unique to the panel).
    await expect(page.getByText('top model:')).toBeVisible()
    await expect(page.getByRole('button', { name: 'About: cache rate' })).toBeVisible()

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
    // §24.55: the seal's cache lane is quantitative (share of prompt tokens
    // served from cache), never a boolean badge.
    await expect(trace.getByTestId('trace-turn')).toContainText('cache 90%')
    // LLM SPEND (§24.69) — the consolidated cost tile, per-class 24h from the
    // seeded request_telemetry rows; exact clean totals (3×$0.07 chat, 2×$0.025
    // sandbox) + a total headline.
    const spend = page.getByTestId('spend-by-class')
    await expect(spend).toBeVisible()
    await expect(page.getByTestId('llm-spend-total')).toBeVisible()
    await expect(page.getByTestId('spend-chat')).toHaveText('$0.21')
    await expect(page.getByTestId('spend-sandbox')).toHaveText('$0.05')

    // §24.57: the fixture window is in the past, so the stream opens with a
    // leading day divider; the seal explains itself via an InfoTip on tap.
    // (Scoped to the turn row — the header's cast InfoTip (§24.60) is the
    // section's first trigger now.)
    await expect(trace.getByTestId('trace-date').first()).toHaveText('Jun 2')
    await trace.getByTestId('trace-turn').first().getByTestId('info-tip-trigger').click()
    await expect(page.getByTestId('info-tip-panel')).toContainText('One container turn')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('info-tip-panel')).toBeHidden()

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

  test('the trace header explains the cast via one InfoTip (§24.60)', async ({ page }) => {
    await page.goto('/live')
    // Retried like funnel.spec's stat-tile tip (§24.65 Δ): under parallel-
    // worker load a click can land during hydration / a late layout settle
    // (the tip closes on scroll), so a single click is racy.
    const panel = page.getByTestId('info-tip-panel')
    await expect(async () => {
      if (await panel.isVisible()) return
      await page.getByRole('button', { name: 'About: who the agents are' }).click()
      await expect(panel).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    await expect(panel).toContainText('pipeline-scribe')
    await expect(panel).toContainText('build-interview-kit')
    await expect(panel).toContainText(/orchestrator/i)
  })

  test('a trace-line [ref] deep-links into the /pipeline drawer (§24.60)', async ({ page }) => {
    await page.goto('/live')
    await page.getByTestId('trace-ref-link').filter({ hasText: 'fintech-a' }).first().click()
    await expect(page).toHaveURL(/\/pipeline\?app=fintech-a/)
    await expect(page.getByRole('dialog', { name: '[fintech-a]' })).toBeVisible()
  })

  test('the /pipeline drawer round-trips into that application’s filtered /live activity (§24.60)', async ({
    page,
  }) => {
    await page.goto('/pipeline?app=fintech-a')
    await expect(page.getByRole('dialog', { name: '[fintech-a]' })).toBeVisible()
    await page.getByTestId('detail-live-link').click()
    await expect(page).toHaveURL(/\/live\?app=fintech-a/)

    // The dismissible app-filter chip is active and the stream is scoped: only
    // fintech-a rows render (every visible [ref] is the filtered one).
    const chip = page.getByTestId('trace-app-filter')
    await expect(chip).toHaveText('[fintech-a] ×')
    await expect(page.getByTestId('trace-line').first()).toBeVisible()
    await expect(page.getByTestId('trace-ref-link').filter({ hasText: 'ai-infra-b' })).toHaveCount(0)

    // Dismissing clears the param and restores the full stream.
    await chip.click()
    await expect(page).toHaveURL('/live')
    await expect(page.getByTestId('trace-app-filter')).toBeHidden()
  })

  test('a Recent-outcomes row deep-links into the /pipeline drawer (§24.57)', async ({ page }) => {
    await page.goto('/live')
    await page.getByTestId('recent-outcome-link').filter({ hasText: 'Wayne Enterprises' }).click()
    await expect(page).toHaveURL(/\/pipeline\?app=Wayne([+ ]|%20)Enterprises/)
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    // Closing clears the param (the drawer state stays shareable but not sticky).
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeHidden()
    await expect(page).toHaveURL('/pipeline')
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

  test('the Job Pipeline panel links into /pipeline (contextual nav — §24.35 Pass A)', async ({ page }) => {
    await page.goto('/live')
    // Scope to main; the funnel panel header action is the only "open →" link.
    await page
      .getByRole('main')
      .getByRole('link', { name: /open →/ })
      .click()
    await expect(page).toHaveURL(/\/pipeline$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Job Pipeline' })).toBeVisible()
  })
})
