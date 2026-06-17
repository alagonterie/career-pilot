import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// §24.36 36.5 — the shareable surface: Open Graph + Twitter-card tags (so a
// pasted link unfurls), the favicon, and the styled 404. Meta tags live in
// <head> (not visible); toHaveAttribute reads them regardless.

test.describe('social meta + favicon + 404 (§24.36 36.5)', () => {
  test('a route exposes the OG + Twitter-card tags + the favicon link', async ({ page }) => {
    await page.goto('/experience')

    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Experience — Jane Doe/)
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'website')
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/og\.png$/)
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /^https?:\/\/.+\/experience$/)
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image')
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  })

  test('the home page (previously head-less) now carries a description + OG title', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/)
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Jane Doe/)
  })

  test('the favicon + og-image assets resolve', async ({ page, baseURL }) => {
    const fav = await page.request.get(`${baseURL}/favicon.svg`)
    expect(fav.status()).toBe(200)
    expect(fav.headers()['content-type']).toContain('svg')

    const og = await page.request.get(`${baseURL}/og.png`)
    expect(og.status()).toBe(200)
    expect(og.headers()['content-type']).toContain('png')
  })

  test('an unknown route renders the styled 404, not a blank (a11y clean)', async ({ page }) => {
    await page.goto('/this-route-does-not-exist')
    const nf = page.getByTestId('not-found')
    await expect(nf).toBeVisible()
    await expect(nf.getByText(/doesn.t exist/i)).toBeVisible()
    await expect(nf.getByRole('link', { name: /go home/i })).toHaveAttribute('href', '/')

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
  })
})
