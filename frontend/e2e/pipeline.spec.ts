import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /pipeline reads the built GET /api/pipeline through a polling hook and renders the
// stage board from the deterministic pipeline seed (scripts/portal-e2e-server.ts
// → seedDeterministicPipeline). Correctness rests on semantic assertions + a11y +
// the console/network gate; the live stage-advance motion is dev-only.
function ignorable(url: string): boolean {
  // The pipeline poll + the landing SSE stream are aborted on nav/teardown —
  // those aborts are expected, not failures.
  return url.includes('/api/pipeline') || url.includes('/api/activity/stream')
}

test('the Bookmarked & closed strip is a one-row filmstrip that scrolls sideways (§24.138 A0-cont)', async ({
  page,
}) => {
  // Override /api/pipeline with a long tail of closed (offboard) apps and prove the
  // strip stays ONE card row tall and scrolls horizontally, instead of wrapping into
  // many rows that grow the page down.
  const mkApp = (i: number) => ({
    application_id: `closed-${i}`,
    application_ref: `co-${i}`,
    public_state: 'obfuscated',
    role_title: 'Senior Software Engineer',
    status: 'rejected',
    stage: 'rejected', // terminal → routed to the Bookmarked & closed strip
    applied_at: '2026-05-01T00:00:00.000Z',
    stage_entered_at: '2026-05-10T00:00:00.000Z',
    last_activity_at: '2026-05-10T00:00:00.000Z',
    win_confidence: null,
    win_confidence_rationale: null,
    published_learning: null,
    days_in_stage: 10,
    days_in_pipeline: 20,
    interview_kits: [],
    learnings: [],
  })
  const applications = Array.from({ length: 24 }, (_, i) => mkApp(i))
  await page.route('**/api/pipeline', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ applications, stage_counts: { rejected: 24 } }),
    }),
  )

  await page.goto('/pipeline')
  const strip = page.getByTestId('pipeline-offboard-cards')
  await expect(strip).toBeVisible()
  // 24 uniform cards in ONE row overflow the width → horizontal scroll; the strip
  // stays one card tall (never wraps into page-growing rows).
  const box = await strip.evaluate((el) => ({
    clientW: el.clientWidth,
    scrollW: el.scrollWidth,
    clientH: el.clientHeight,
  }))
  expect(box.scrollW).toBeGreaterThan(box.clientW + 1) // overflows the width → scrolls sideways
  expect(box.clientH).toBeLessThan(220) // a single card row, not many wrapped rows
})

test.describe('/pipeline — the pipeline board, frontend <-> backend', () => {
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

    await expect(page.getByRole('heading', { level: 1, name: 'My Job Pipeline' })).toBeVisible()

    // Board renders from the seeded /api/pipeline over the polling hook.
    const board = page.getByTestId('pipeline-board')
    await expect(board).toBeVisible()
    for (const col of ['Applied', 'Screening', 'Tech interview', 'Final interview', 'Offer']) {
      await expect(page.getByRole('region', { name: col })).toBeVisible()
    }

    // Reveal tier: obfuscated by default (§24.137 anonymization chip — the stable
    // handle, no longer raw `[brackets]`); the public OFFER shows its real name.
    await expect(page.getByTestId('company-handle').filter({ hasText: 'fintech-a' })).toBeVisible()
    await expect(page.getByText('Wayne Enterprises')).toBeVisible()
    await expect(page.getByTestId('reveal-marker')).toBeVisible()

    // §24.153 item 1: the board is signed by its curator — the pipeline-scribe ✦
    // provenance mark sits in the footer (the board has content here, so it shows).
    const curatorMark = page.locator('[data-testid="agent-mark"][data-actor="pipeline-scribe"]')
    await expect(curatorMark).toContainText('Curated by')
    await expect(curatorMark.getByTestId('agent-ref')).toHaveAttribute('data-actor', 'pipeline-scribe')

    // Click a card → the detail side-panel opens, then closes.
    await page.getByText('Wayne Enterprises').click()
    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()
    // §24.73: the win-confidence score is attributed to the host model that wrote it.
    await expect(panel.getByTestId('agent-ref').filter({ hasText: 'win-confidence' })).toBeVisible()
    // §24.117: the published reflections render as a "Lessons learned" list
    // (newest first — the offer retro leads), the rejection-as-fuel loop made visible.
    const lessons = panel.getByTestId('detail-learning')
    await expect(lessons).toHaveCount(2)
    await expect(lessons.first()).toContainText('After the offer')
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
    const card = page.getByTestId('pipeline-card').filter({ hasText: 'Wayne Enterprises' })
    await card.focus()
    await page.keyboard.press('Enter')

    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()
    // Focus lands in the dialog shell on open.
    await expect(panel).toBeFocused()

    // Tab cycles the dialog's tabbables (Close → Live activity → the
    // Interview-prep InfoTip + the two seeded kit rows (§24.65) → the §24.73
    // win-confidence-scorer AgentRef chip → the §24.117 "Lessons learned" InfoTip
    // + its pipeline-scribe AgentRef chip, the last tabbable) and the trap wraps
    // at both ends — focus never escapes the page behind.
    const close = panel.getByRole('button', { name: 'Close panel' })
    const liveLink = panel.getByTestId('detail-live-link')
    const kitTip = panel.getByRole('button', { name: 'About: interview prep' })
    const kitLinks = panel.getByTestId('detail-kit-link')
    const winRef = panel.getByTestId('agent-ref').filter({ hasText: 'win-confidence' })
    const learningsTip = panel.getByRole('button', { name: 'About: lessons learned' })
    const learningsRef = panel.getByTestId('detail-learnings').getByTestId('agent-ref')
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(liveLink).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(kitTip).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(kitLinks.first()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(kitLinks.nth(1)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(winRef).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(learningsTip).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(learningsRef).toBeFocused()
    await page.keyboard.press('Tab') // off the end → wraps to the start
    await expect(close).toBeFocused()
    await page.keyboard.press('Shift+Tab') // off the top → wraps to the end
    await expect(learningsRef).toBeFocused()

    // Escape closes and focus returns to the triggering card.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(card).toBeFocused()
  })

  test('closing the drawer preserves the scroll position (§24.58 Δ)', async ({ page }) => {
    await page.goto('/pipeline')
    await expect(page.getByTestId('pipeline-card').first()).toBeVisible()
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
    await expect(page.getByTestId('pipeline-board')).toBeVisible()
  })

  test('/momentum redirects to /pipeline, ?app preserved (§24.59)', async ({ page }) => {
    // Pre-rename links (bookmarks, old /dashboard outcome deep-links) keep working.
    await page.goto('/momentum?app=Wayne%20Enterprises')
    await expect(page).toHaveURL(/\/pipeline\?app=Wayne([+ ]|%20)Enterprises/)
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    await page.goto('/momentum')
    await expect(page).toHaveURL('/pipeline')
    await expect(page.getByRole('heading', { level: 1, name: 'My Job Pipeline' })).toBeVisible()
  })

  test('?app deep-link opens the drawer once the pipeline loads (§24.57)', async ({ page }) => {
    await page.goto('/pipeline?app=Wayne%20Enterprises')
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
    // An unknown ref is a no-op — the board renders, no drawer.
    await page.goto('/pipeline?app=not-a-real-ref')
    await expect(page.getByTestId('pipeline-card').first()).toBeVisible()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('stat tiles + the drawer explain themselves via InfoTips (§24.60)', async ({ page }) => {
    await page.goto('/pipeline')
    // The one stat tile whose derivation isn't obvious from its label (§24.79 D1:
    // `Avg days active`) opens its honest caveat on tap. Retried like mobile.spec's
    // openMenu: under parallel-worker load a click can land during hydration /
    // a late layout settle (the tip closes on scroll), so a single click is
    // racy — re-click until the panel holds (flaked 3× in-file, §24.62 family).
    await expect(async () => {
      if (await page.getByTestId('info-tip-panel').isVisible()) return
      await page.getByRole('button', { name: 'About: Avg days active' }).click()
      await expect(page.getByTestId('info-tip-panel')).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    await expect(page.getByTestId('info-tip-panel')).toContainText(/heuristic/i)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('info-tip-panel')).toBeHidden()

    // The drawer's win-confidence-scorer chip (the seeded public OFFER carries a
    // score) — §24.73: its popover carries the "heuristic, not a promise" framing.
    await page.getByText('Wayne Enterprises').click()
    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()
    await panel.getByTestId('agent-ref').filter({ hasText: 'win-confidence' }).click()
    await expect(page.getByTestId('agent-ref-panel')).toContainText(/not a promise/i)
  })

  test('the drawer’s Interview prep rows open the /kit dossier; back returns to the drawer (§24.65)', async ({
    page,
  }) => {
    await page.goto('/pipeline')
    await page.getByText('Wayne Enterprises').click()
    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()

    // The public OFFER carries its two archived kits — the prep story survives the close (D1).
    const rows = panel.getByTestId('detail-kit-link')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Recruiter screen')
    await expect(rows.first()).toContainText('archived')

    // Into the dossier: a revealed application shows its kit IN FULL.
    await rows.nth(1).click()
    await expect(page).toHaveURL(/\/kit\?app=Wayne([+ ]|%20)Enterprises&round=TECH_SCREEN/)
    await expect(page.getByTestId('kit-masthead')).toContainText('Wayne Enterprises')
    await expect(page.getByTestId('kit-banner-public')).toContainText('revealed post-close')
    // Real content renders — incl. the sections that would be sealed while live.
    // This fixture carries the Drive-export dialect (§24.65 Δ): the rubric is a
    // pipe TABLE, lists use `*`/`1.`, punctuation arrives backslash-escaped.
    const rubric = page.getByTestId('kit-section-scoring-rubric')
    await expect(rubric.locator('table')).toBeVisible()
    await expect(rubric).toContainText('Problem decomposition')
    await expect(page.getByTestId('kit-section-gap-notes')).toContainText('Kubernetes operators')
    await expect(page.getByText('Part 2 — Candidate quick-reference')).toBeVisible()
    // No escape backslashes or pipe-soup survive the renderer.
    await expect(page.getByTestId('kit-dossier')).not.toContainText('\\+')

    // Browser back lands on /pipeline?app=… → the drawer re-opens (URL is the
    // source of truth, §24.58) — the stack feel with zero new dialog code.
    await page.goBack()
    await expect(page).toHaveURL(/\/pipeline\?app=/)
    await expect(page.getByRole('dialog', { name: 'Wayne Enterprises' })).toBeVisible()
  })

  test('a live application’s kit renders the sealed dossier skeleton (§24.65)', async ({ page }) => {
    await page.goto('/kit?app=ai-infra-a&round=TECH_SCREEN')

    await expect(page.getByTestId('kit-masthead')).toContainText('[ai-infra-a]')
    await expect(page.getByTestId('kit-banner-sealed')).toContainText('sections that would identify the company')

    // Safe sections render real content — the company name is redacted by the
    // server-side pipeline (the fixture names it on purpose) and rendered as the
    // §24.134d company chip: the stable pseudonym, never the real name or the
    // literal [REDACTED:…] token.
    const roleChip = page.getByTestId('kit-section-your-role').getByTestId('redaction-chip').first()
    await expect(roleChip).toHaveAttribute('data-tier', 'company')
    await expect(roleChip).toContainText('ai-infra-a')
    await expect(page.getByTestId('kit-section-your-role')).not.toContainText('[REDACTED')
    // Identifying sections are sealed: redaction bars + the honest caption, no text.
    const grounding = page.getByTestId('kit-sealed-grounding')
    await expect(grounding.getByTestId('kit-redaction-bars')).toBeVisible()
    await expect(grounding).toContainText(/grounding facts · sealed while this process is live/)
    await expect(page.getByTestId('kit-sealed-gap-notes')).toContainText(/probed/)
    // The seal is server-side: the real company name appears NOWHERE on the page.
    await expect(page.locator('body')).not.toContainText('Initech')
    // Sealed sections stay in the TOC, marked ⊘ — structure is provable.
    await expect(page.locator('[data-testid="kit-toc-entry"][data-sealed]').first()).toBeAttached()

    // The dossier page is axe-clean like every other route. Wait out the
    // entrance fade first — axe sampling text inside a container at opacity<1
    // reads as a fake contrast failure (the §24.58 axe-mid-transition trap;
    // reduced-motion doesn't help, motion still animates opacity under it).
    await expect(page.getByTestId('kit-dossier')).toHaveCSS('opacity', '1')
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
  })

  test('an unknown kit ref shows the honest missing state (§24.65)', async ({ page }) => {
    await page.goto('/kit?app=not-a-ref&round=FINAL')
    await expect(page.getByTestId('kit-missing')).toBeVisible()
    await expect(page.getByRole('link', { name: /back to the pipeline/i })).toBeVisible()
  })

  test('the shared header nav reaches /pipeline and back', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })

    await nav.getByRole('link', { name: 'My Job Pipeline' }).click()
    await expect(page).toHaveURL('/pipeline')
    await expect(page.getByRole('heading', { level: 1, name: 'My Job Pipeline' })).toBeVisible()

    await nav.getByRole('link', { name: 'Jane Doe' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('hero-status')).toBeVisible()
  })
})
