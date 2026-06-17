import { expect, test } from '@playwright/test'

// §24.77 D1: the renamed routes keep their old paths alive as thin redirect stubs
// so shared / bookmarked links never 404. Each old path redirects (replace) to the
// new one, carrying its search / path params. The /momentum → /pipeline redirect
// (the §24.59 precedent) is covered in funnel.spec.
test.describe('§24.77 route redirects — old paths still resolve', () => {
  test('/live → /dashboard, ?app carried', async ({ page }) => {
    await page.goto('/live?app=fintech-a')
    await expect(page).toHaveURL(/\/dashboard\?app=fintech-a/)
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await page.goto('/live')
    await expect(page).toHaveURL('/dashboard')
  })

  test('/work → /experience', async ({ page }) => {
    await page.goto('/work')
    await expect(page).toHaveURL('/experience')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('/simulator → /watch', async ({ page }) => {
    await page.goto('/simulator')
    await expect(page).toHaveURL('/watch')
    await expect(page.getByRole('heading', { level: 1, name: /watch me apply to your role/i })).toBeVisible()
  })

  test('/simulator/results/:id → /watch/results/:id, id carried', async ({ page }) => {
    await page.goto('/simulator/results/det-sim-1')
    await expect(page).toHaveURL('/watch/results/det-sim-1')
  })
})
