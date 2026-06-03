import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// §24.36 36.1 — the mock-only `?__state` override (honored by the E2E portal API
// through PORTAL_MOCK_STATE_SEAM) makes the loading / empty / error UIs reachable,
// which the always-seeded + instant DB otherwise hides. Each async surface must
// render its themed treatment — a shaped skeleton, a themed note, or a stream
// "connecting…" affordance — never a bare blank.
//
// The network/console gates the other specs run are intentionally omitted here:
// `loading` deliberately hangs requests (aborted on teardown) and `error`
// deliberately returns 500s, so that noise is expected, not a failure.

test.describe('/momentum async states', () => {
  test('loading → a skeleton board, not the real board', async ({ page }) => {
    await page.goto('/momentum?__state=loading')
    await expect(page.getByRole('heading', { level: 1, name: 'Momentum' })).toBeVisible()
    await expect(page.getByTestId('funnel-skeleton')).toBeVisible()
    await expect(page.getByTestId('funnel-board')).toHaveCount(0)
  })

  test('empty → a themed empty note (a11y clean)', async ({ page }) => {
    await page.goto('/momentum?__state=empty')
    const note = page.getByTestId('funnel-empty')
    await expect(note).toBeVisible()
    await expect(note).toContainText(/no applications/i)
    await expect(page.getByTestId('funnel-board')).toHaveCount(0)
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
  })

  test('error → a themed offline note', async ({ page }) => {
    await page.goto('/momentum?__state=error')
    const note = page.getByTestId('funnel-error')
    await expect(note).toBeVisible()
    await expect(note).toContainText(/offline/i)
  })
})

test.describe('/architecture async states', () => {
  test('loading → a skeleton diagram, not the real map', async ({ page }) => {
    await page.goto('/architecture?__state=loading')
    await expect(page.getByRole('heading', { level: 1, name: 'Architecture' })).toBeVisible()
    await expect(page.getByTestId('arch-skeleton')).toBeVisible()
    await expect(page.getByTestId('arch-diagram')).toHaveCount(0)
  })

  test('error → a themed offline note', async ({ page }) => {
    await page.goto('/architecture?__state=error')
    const note = page.getByTestId('arch-empty')
    await expect(note).toBeVisible()
    await expect(note).toContainText(/offline/i)
  })
})

test.describe('/live async states', () => {
  test('loading → panel skeletons + a connecting trace stream', async ({ page }) => {
    await page.goto('/live?__state=loading')
    await expect(page.getByRole('heading', { level: 1, name: 'Live' })).toBeVisible()
    await expect(page.getByTestId('panel-skeleton').first()).toBeVisible()
    await expect(page.getByTestId('trace-empty')).toContainText(/connecting/i)
  })

  test('empty → a connected-but-quiet trace stream', async ({ page }) => {
    await page.goto('/live?__state=empty')
    await expect(page.getByTestId('trace-empty')).toContainText(/no agent activity/i)
  })
})
