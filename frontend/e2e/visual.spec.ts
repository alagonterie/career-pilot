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
  await expect(page.getByRole('heading', { name: 'Alexander LaGonterie', level: 1 })).toBeVisible()
  // Wait for the seeded backlog to render so the snapshot is deterministic.
  await expect(page.getByTestId('live-ticker')).toContainText('research-company')
  await expect(page).toHaveScreenshot('home.png', {
    animations: 'disabled',
    fullPage: true,
  })
})
