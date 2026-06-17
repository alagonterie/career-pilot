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

test.describe('/pipeline async states', () => {
  test('loading → a skeleton board, not the real board', async ({ page }) => {
    await page.goto('/pipeline?__state=loading')
    await expect(page.getByRole('heading', { level: 1, name: 'My Job Pipeline' })).toBeVisible()
    await expect(page.getByTestId('funnel-skeleton')).toBeVisible()
    await expect(page.getByTestId('funnel-board')).toHaveCount(0)
  })

  test('empty → a themed empty note (a11y clean)', async ({ page }) => {
    await page.goto('/pipeline?__state=empty')
    const note = page.getByTestId('funnel-empty')
    await expect(note).toBeVisible()
    await expect(note).toContainText(/no applications/i)
    await expect(page.getByTestId('funnel-board')).toHaveCount(0)
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
  })

  test('error → a themed offline note', async ({ page }) => {
    await page.goto('/pipeline?__state=error')
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

test.describe('/dashboard async states', () => {
  test('loading → panel skeletons + a connecting trace stream', async ({ page }) => {
    await page.goto('/dashboard?__state=loading')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await expect(page.getByTestId('panel-skeleton').first()).toBeVisible()
    await expect(page.getByTestId('trace-empty')).toContainText(/connecting/i)
  })

  test('empty → a connected-but-quiet trace stream', async ({ page }) => {
    await page.goto('/dashboard?__state=empty')
    await expect(page.getByTestId('trace-empty')).toContainText(/no agent activity/i)
  })
})

test.describe('reduced-motion (§24.36 36.4)', () => {
  test('the global reset makes CSS animation inert under prefers-reduced-motion', async ({ page }) => {
    // The loading skeleton renders Tailwind `animate-pulse` (and `?__state=loading`
    // hangs, so it stays put for the measurement).
    const pulseDurationS = () =>
      page
        .locator('.animate-pulse')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))

    // Control: with no preference, the pulse runs.
    await page.goto('/pipeline?__state=loading')
    await expect(page.getByTestId('funnel-skeleton')).toBeVisible()
    expect(await pulseDurationS()).toBeGreaterThan(0.5)

    // Treatment: under prefers-reduced-motion the app.css global reset neutralizes
    // it (the media query re-matches live — no reload needed).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('funnel-skeleton')).toBeVisible()
    expect(await pulseDurationS()).toBeLessThan(0.001)
  })
})
