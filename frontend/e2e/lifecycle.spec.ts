import { expect, test } from '@playwright/test'

// §24.149 L2 — the concluded-search retrospective. The dev/mock `?__lifecycle=`
// override (honored only under the VITE_MOCK_SEAM build, which this E2E uses)
// flips the lifecycle without a DB write, so the banner is reachable here without
// a seeded-state change. Real prod ignores the param — only the server-delivered
// `site_lifecycle` drives the mode.

test.describe('site lifecycle — concluded retrospective', () => {
  test('the pipeline leads with the concluded banner under ?__lifecycle=concluded', async ({ page }) => {
    await page.goto('/pipeline?__lifecycle=concluded')
    const banner = page.getByTestId('concluded-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/search concluded/i)
    await expect(banner).toContainText(/accepted an offer/i)
  })

  test('the home leads with the concluded banner + a pipeline link', async ({ page }) => {
    await page.goto('/?__lifecycle=concluded')
    const banner = page.getByTestId('concluded-banner')
    await expect(banner).toBeVisible()
    await expect(banner.getByRole('link', { name: /see the full pipeline/i })).toBeVisible()
  })

  test('no banner in the normal (active) lifecycle', async ({ page }) => {
    await page.goto('/pipeline')
    await expect(page.getByTestId('concluded-banner')).toHaveCount(0)
  })
})
