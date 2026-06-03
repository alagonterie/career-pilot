import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Mobile / responsive E2E (§24.37 + PORTAL §13). Runs ONLY on the
// `mobile-chromium` project (Pixel 5, ~393px) via playwright.config `testMatch`.
// The functional + axe tests run in CI; the @visual baselines are skipped there
// (`--grep-invert @visual`), like the desktop ones — pixel baselines are
// OS-specific. The phone-primary contract: every page stacks with no horizontal
// scroll, the nav collapses to a hamburger, /live leads with the trace, the
// funnel board stacks, and architecture nodes stay tappable.

const ROUTES = [
  '/',
  '/work',
  '/contact',
  '/simulator',
  '/simulator/results/det-sim-1',
  '/momentum',
  '/architecture',
  '/live',
]

// Navigate + wait for the route's primary content so the layout has settled
// before measuring (mirrors the hydration gates used across the desktop specs).
async function gotoStable(page: Page, path: string): Promise<void> {
  await page.goto(path)
  if (path === '/architecture') {
    await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
  } else if (path === '/live') {
    await expect(page.getByTestId('trace-stream')).toBeVisible()
  } else if (path === '/momentum') {
    await expect(page.getByTestId('funnel-board')).toBeVisible()
  } else {
    await expect(page.locator('h1').first()).toBeVisible()
  }
}

// Open the hamburger menu, retrying through the SSR→hydrate window (a click that
// lands before the handler attaches is dropped) without toggling it back shut.
async function openMenu(page: Page): Promise<void> {
  await expect(async () => {
    if (await page.getByTestId('nav-menu').isVisible()) return
    await page.getByTestId('nav-hamburger').click()
    await expect(page.getByTestId('nav-menu')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
}

test('no route scrolls horizontally at a phone width', async ({ page }) => {
  for (const path of ROUTES) {
    await gotoStable(page, path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1)
  }
})

test('the top nav collapses to a working hamburger menu', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeVisible()

  const burger = page.getByTestId('nav-hamburger')
  await expect(burger).toBeVisible()
  await expect(burger).toHaveAttribute('aria-expanded', 'false')
  // ≥44px tap target (WCAG 2.5.5 / Apple HIG).
  const box = await burger.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)

  await openMenu(page)
  await expect(burger).toHaveAttribute('aria-expanded', 'true')

  // A menu link navigates and the menu closes after.
  await page.getByTestId('nav-menu').getByRole('link', { name: 'Architecture' }).click()
  await expect(page).toHaveURL(/\/architecture$/)
  await expect(page.getByTestId('nav-menu')).toHaveCount(0)
})

test('the hamburger menu closes on Escape', async ({ page }) => {
  await page.goto('/')
  await openMenu(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('nav-menu')).toHaveCount(0)
  await expect(page.getByTestId('nav-hamburger')).toHaveAttribute('aria-expanded', 'false')
})

test('/live leads with the trace stream on mobile (not the stat tiles)', async ({ page }) => {
  await page.goto('/live')
  await expect(page.getByTestId('trace-stream')).toBeVisible()
  const trace = await page.getByTestId('trace-stream').boundingBox()
  const stats = await page.getByText('System status', { exact: true }).first().boundingBox()
  // Trace-first (§13): the centerpiece sits above the stat row when stacked.
  expect(trace!.y).toBeLessThan(stats!.y)
})

test('/momentum stacks the funnel board into a single column on mobile', async ({ page }) => {
  await page.goto('/momentum')
  await expect(page.getByTestId('funnel-board')).toBeVisible()
  const applied = await page.getByTestId('funnel-col-applied').boundingBox()
  const offer = await page.getByTestId('funnel-col-offer').boundingBox()
  // Single column → same left edge, stacked top-to-bottom.
  expect(Math.abs(applied!.x - offer!.x)).toBeLessThan(2)
  expect(offer!.y).toBeGreaterThan(applied!.y)
})

test('/architecture nodes stay tappable and open the detail sheet on mobile', async ({ page }) => {
  await page.goto('/architecture')
  await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')

  const node = page.getByTestId('arch-node-cont-runtime')
  const box = await node.boundingBox()
  // The diagram scales to ~45%, so the overlay buttons carry a ≥44px hit area.
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)

  await node.click()
  await expect(page.getByTestId('arch-node-panel')).toBeVisible()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('key mobile surfaces are axe-clean (incl. the open nav menu)', async ({ page }) => {
  await page.goto('/')
  await openMenu(page)
  const home = await new AxeBuilder({ page }).analyze()
  expect(home.violations).toEqual([])

  await gotoStable(page, '/live')
  const live = await new AxeBuilder({ page }).analyze()
  expect(live.violations).toEqual([])
})

// ── @visual mobile baselines (skipped in CI; OS-specific) ────────────────────

test('mobile home matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('live-ticker')).toContainText('research-company')
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-home.png', { animations: 'disabled', fullPage: true })
})

test('mobile nav menu (open) matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/')
  await openMenu(page)
  // Viewport (not fullPage) so the snapshot frames the header + the open menu.
  await expect(page).toHaveScreenshot('mobile-nav-open.png', { animations: 'disabled' })
})

test('mobile momentum matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/momentum')
  await expect(page.getByTestId('funnel-board')).toBeVisible()
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-momentum.png', {
    animations: 'disabled',
    fullPage: true,
    mask: [page.getByTestId('funnel-card-age'), page.getByTestId('stat-value')],
  })
})

test('mobile architecture matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/architecture')
  await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
  await expect(page).toHaveScreenshot('mobile-architecture.png', { animations: 'disabled', fullPage: true })
})

test('mobile live matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/live')
  await expect(page.getByTestId('trace-stream')).toBeVisible()
  await expect(page.getByTestId('trace-stream').getByText('research-company')).toBeVisible()
  await expect(page.getByTestId('funnel-compact-reveal')).toContainText('Wayne Enterprises')
  await expect(page).toHaveScreenshot('mobile-live.png', {
    animations: 'disabled',
    fullPage: true,
    mask: [page.getByTestId('live-volatile')],
  })
})
