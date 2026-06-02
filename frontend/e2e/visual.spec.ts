import { expect, test } from '@playwright/test'

// Visual-regression guard. Pixel baselines are a *regression* guard only (they
// can't tell a broken first render from a good one — that's what smoke.spec.ts'
// semantic + a11y checks are for). Animations are disabled for determinism.
//
// Tagged @visual so CI (Linux) skips it: screenshot baselines are OS-specific
// (font hinting differs), and the committed baseline is generated on the dev
// OS. The semantic + a11y E2E is the cross-platform gate that runs everywhere.
test('home page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeVisible()
  // Wait for the seeded backlog to render so the snapshot is deterministic.
  await expect(page.getByTestId('live-ticker')).toContainText('research-company')
  await expect(page).toHaveScreenshot('home.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('work page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/work')
  await expect(page.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Experience', level: 2 })).toBeVisible()
  await expect(page).toHaveScreenshot('work.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('funnel page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/funnel')
  await expect(page.getByRole('heading', { name: 'Funnel', level: 1 })).toBeVisible()
  // Wait for the board to render from the seeded API so the snapshot is stable.
  await expect(page.getByTestId('funnel-board')).toBeVisible()
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('funnel.png', {
    animations: 'disabled',
    fullPage: true,
    // Day-counts + date-windowed stat values derive from wall-clock and drift
    // daily; mask them (the layout is the regression guard, the numbers are
    // covered by the unit + semantic tests).
    mask: [page.getByTestId('funnel-card-age'), page.getByTestId('stat-value')],
  })
})
