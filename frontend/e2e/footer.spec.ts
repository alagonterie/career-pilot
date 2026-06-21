import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// The sitewide footer — the slim social/legal strip (PORTAL §8.2 / STRATEGY
// §24.76). Functional + a11y only (its pixels ride the @visual re-bless). Proves
// the strip renders on both register layouts and the two background doorways
// resolve: "About" → /about (the second entrance after the home beat) and
// "Privacy" → /privacy (the formal policy the OAuth consent screen points to, §24.148).
//
// The themed social icons are omit-when-null over the SSR'd identity; the harness
// leaves the SSR server-fns un-backed (only the client hooks read the seeded
// backend), so identity is empty here and the icons don't render — the same reason
// the hero shows the placeholder name. Their omit-when-null mapping is covered by
// the footerSocials unit test; their render is verified locally against a seeded
// backend via .dev.vars.
test.describe('site footer — the social/legal strip', () => {
  for (const path of ['/', '/dashboard']) {
    test(`renders on ${path} with the About/Privacy doorways`, async ({ page }) => {
      await page.goto(path)
      const footer = page.getByTestId('site-footer')
      await expect(footer).toBeVisible()

      // About is /about's second framed entrance; Privacy is the formal policy page
      // (the OAuth consent screen's privacy URL, §24.148).
      await expect(footer.getByTestId('footer-about')).toHaveAttribute('href', '/about')
      await expect(footer.getByTestId('footer-privacy')).toHaveAttribute('href', '/privacy')

      // The §24.139 product version chip — byte-stable `dev` under the local
      // build (VITE_APP_VERSION unset), link-free so no SHA enters a @visual baseline.
      await expect(footer.getByTestId('footer-version')).toHaveText('dev')

      // The footer is on every page now — it must carry zero a11y violations.
      const a11y = await new AxeBuilder({ page }).include('[data-testid="site-footer"]').analyze()
      expect(a11y.violations).toEqual([])
    })
  }

  test('Privacy lands on the formal policy page with the Google-data disclosure', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('site-footer').getByTestId('footer-privacy').click()
    await expect(page).toHaveURL(/\/privacy$/)
    // The OAuth-required section (the Gmail Limited Use disclosure) is present.
    await expect(page.getByTestId('privacy-google-data')).toBeVisible()
    await expect(page.getByTestId('privacy-google-data')).toContainText(/Limited Use/i)
  })
})
