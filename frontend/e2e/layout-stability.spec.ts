import { expect, test } from '@playwright/test'

// §24.62 layout stability: the root reserves its scrollbar gutter
// (html { scrollbar-gutter: stable }), so the classic-scrollbar appearing and
// disappearing — between pages of different heights AND under useDialog's
// body scroll-lock — can no longer shift centered layouts sideways. The
// probes measure the header brand's x-position, the most visible victim of
// the half-scrollbar-width wobble.

async function brandX(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.locator('header nav a', { hasText: 'Jane Doe' }).boundingBox()
  if (!box) throw new Error('header brand not found')
  return box.x
}

test.describe('§24.62 — root scrollbar gutter holds layouts still', () => {
  test('the root declares a stable scrollbar gutter', async ({ page }) => {
    await page.goto('/')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe('stable')
  })

  test('opening the pipeline drawer does not shift the page sideways', async ({ page }) => {
    await page.goto('/pipeline')
    await expect(page.getByTestId('funnel-board')).toBeVisible()

    const before = await brandX(page)
    await page.getByText('Wayne Enterprises').click()
    const panel = page.getByRole('dialog', { name: 'Wayne Enterprises' })
    await expect(panel).toBeVisible()
    // The scroll-lock is active (the scrollbar would be gone without the gutter) …
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
    // … and the header has not moved.
    expect(await brandX(page)).toBe(before)
  })

  test('opening an architecture node panel does not shift the page sideways', async ({ page }) => {
    await page.goto('/architecture')
    await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')

    const before = await brandX(page)
    await page.getByTestId('arch-node-cont-runtime').click()
    await expect(page.getByTestId('arch-node-panel')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
    expect(await brandX(page)).toBe(before)
  })

  test('the header brand sits at the same x on a scrolling page and a scroll-free page', async ({ page }) => {
    // Same viewport width throughout; only the page (and so the scrollbar)
    // changes. A 2000px-tall viewport makes /contact genuinely scroll-free,
    // while /live always overflows — without the reserved gutter the brand
    // would sit half a scrollbar width apart between the two.
    await page.setViewportSize({ width: 1280, height: 2000 })

    await page.goto('/live')
    await expect(page.getByRole('heading', { level: 1, name: 'Live' })).toBeVisible()
    const scrolling = await brandX(page)

    await page.goto('/contact')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // Precondition: /contact really is scroll-free at this height (otherwise
    // this test silently proves nothing — bump the viewport if the page grew).
    const overflows = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
    )
    expect(overflows).toBe(false)
    // The gutter stays reserved even with no scrollbar to draw (it shows up
    // in the body's layout width, not documentElement.clientWidth) …
    const gutter = await page.evaluate(() => window.innerWidth - document.body.getBoundingClientRect().width)
    expect(gutter).toBeGreaterThan(0)
    // … so the brand has not moved.
    expect(await brandX(page)).toBe(scrolling)
  })
})
