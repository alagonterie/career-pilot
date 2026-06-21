import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Mobile / responsive E2E (§24.37 + PORTAL §13). Runs ONLY on the
// `mobile-chromium` project (Pixel 5, ~393px) via playwright.config `testMatch`.
// The functional + axe tests run in CI; the @visual baselines are skipped there
// (`--grep-invert @visual`), like the desktop ones — pixel baselines are
// OS-specific. The phone-primary contract: every page stacks with no horizontal
// scroll, the nav collapses to a hamburger, /dashboard leads with the trace, the
// funnel board stacks, and architecture nodes stay tappable.

const ROUTES = [
  '/',
  '/about',
  '/experience',
  '/contact',
  '/watch',
  '/watch/results/det-sim-1',
  '/pipeline',
  '/architecture',
  '/dashboard',
  '/kit?app=ai-infra-a&round=TECH_SCREEN', // §24.65 — chips + redaction bars must reflow
]

// Navigate + wait for the route's primary content so the layout has settled
// before measuring (mirrors the hydration gates used across the desktop specs).
async function gotoStable(page: Page, path: string): Promise<void> {
  await page.goto(path)
  if (path === '/architecture') {
    await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
  } else if (path === '/dashboard') {
    await expect(page.getByTestId('trace-stream')).toBeVisible()
  } else if (path === '/pipeline') {
    await expect(page.getByTestId('funnel-board')).toBeVisible()
  } else if (path.startsWith('/kit')) {
    await expect(page.getByTestId('kit-masthead')).toBeVisible()
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

// Ten full-reload navigations in one test. Each SSR pass now runs the register
// layout's identity loader, whose fetch to the (intentionally unreachable in the
// harness) backend slow-fails on Windows-localhost at ~4s/nav — fast on Linux CI,
// but locally 10 × ~4s overruns the 30s default. The work is real, not stuck, so
// give the budget room rather than mask it.
test('no route scrolls horizontally at a phone width', async ({ page }) => {
  test.setTimeout(90_000)
  for (const path of ROUTES) {
    await gotoStable(page, path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1)
  }
})

// The mid-run 2-pane view carries the long mono trace lines — the overflow
// case the static input-view check above can't catch (§24.31 Δ; found on a
// real phone). Drives the mock run, then measures with content present.
test('the mid-run simulator view does not scroll horizontally on mobile', async ({ page }) => {
  await page.goto('/watch')
  await expect(async () => {
    if (await page.getByTestId('sim-activity').isVisible()) return
    await page.getByLabel('Company name').fill('Wayne Enterprises')
    await page.getByLabel('Role / title').fill('Principal Engineer')
    await page.getByRole('button', { name: /watch me apply/i }).click()
    await expect(page.getByTestId('sim-activity')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 15_000 })
  await expect(page.getByTestId('sim-trace-subagent').first()).toBeVisible()
  await expect(page.getByTestId('sim-results')).toBeVisible() // run done → output present too

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'horizontal overflow on the mid-run /watch view').toBeLessThanOrEqual(1)
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

test('/dashboard leads with the trace stream on mobile (not the stat tiles)', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page.getByTestId('trace-stream')).toBeVisible()
  const trace = await page.getByTestId('trace-stream').boundingBox()
  // Anchor on the first stat tile (system status is now an unboxed header strip
  // above the trace — §24.69 follow-up — so the stat ROW is the Active-sessions tile).
  const stats = await page.getByText('Active sessions', { exact: true }).first().boundingBox()
  // Trace-first (§13): the centerpiece sits above the stat row when stacked.
  expect(trace!.y).toBeLessThan(stats!.y)
})

test('/pipeline stacks the funnel board into a single column on mobile', async ({ page }) => {
  await page.goto('/pipeline')
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

test('/architecture pinch zooms only the diagram; reset restores page scrolling (§24.64)', async ({ page }) => {
  await page.goto('/architecture')
  await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')

  const diagram = page.getByTestId('arch-diagram')
  const box = await diagram.boundingBox()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2

  // Playwright's touchscreen has no pinch — drive two raw touch points apart
  // via CDP. CDP touch events synthesize the pointer events the handler reads.
  const cdp = await page.context().newCDPSession(page)
  const pts = (d: number) => [
    { x: cx - d, y: cy, id: 0 },
    { x: cx + d, y: cy, id: 1 },
  ]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(20) })
  for (const d of [40, 60, 80]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  // Only the diagram's transform layer scaled — the page header is untouched
  // and the wrapper traded page scroll for map panning.
  const layer = page.getByTestId('arch-zoom-layer')
  await expect.poll(async () => layer.evaluate((el) => el.style.transform)).toContain('scale')
  const scale = await layer.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
  expect(scale).toBeGreaterThan(1)
  await expect(diagram).toHaveCSS('touch-action', 'none')
  await expect(page.getByRole('heading', { name: 'Architecture' })).toBeVisible()

  // A plain tap (true touch — .click() would synthesize mouse events the
  // touch-only handler never sees) still opens a node sheet while zoomed.
  await page.getByTestId('arch-node-cont-orch').tap()
  await expect(page.getByTestId('arch-node-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Close panel' }).click()

  // The reset chip is the honest exit: identity transform + page scroll back.
  await page.getByTestId('arch-zoom-reset').click()
  await expect(diagram).toHaveCSS('touch-action', 'pan-y')
  await expect(page.getByTestId('arch-zoom-reset')).toHaveCount(0)
})

test('/kit TOC steppers scroll the page BOTH directions (§24.65 Δ)', async ({ page }) => {
  // Regression for the probed Chromium one-smooth-scroll-at-a-time trap: the
  // strip's auto-scroll cancelled the page scroll whenever the target chip sat
  // outside the strip (always on ‹; on › once the jump reached an off-strip
  // chip). The fix sequences them — strip instantly first, page scroll a frame
  // later — so every step must actually travel.
  await page.goto('/kit?app=ai-infra-a&round=TECH_SCREEN')
  await expect(page.getByTestId('kit-sealed-grounding')).toBeVisible()
  await expect(page.getByTestId('kit-dossier')).toHaveCSS('opacity', '1')

  const y = () => page.evaluate(() => Math.round(window.scrollY))
  const settle = async () => {
    let last = -1
    await expect
      .poll(async () => {
        const now = await y()
        const stable = now === last
        last = now
        return stable
      })
      .toBe(true)
    return last
  }

  const positions: number[] = []
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('kit-toc-next').tap()
    positions.push(await settle())
  }
  // Three content sections (your-role, scoring-rubric, lean-into) — strictly downward.
  expect(positions[0]).toBeGreaterThan(0)
  expect(positions[1]).toBeGreaterThan(positions[0])
  expect(positions[2]).toBeGreaterThan(positions[1])

  // Back up — both ‹ steps must travel (the always-broken direction).
  await page.getByTestId('kit-toc-prev').tap()
  const back1 = await settle()
  expect(back1).toBeLessThan(positions[2])
  await page.getByTestId('kit-toc-prev').tap()
  const back2 = await settle()
  expect(back2).toBeLessThan(back1)
  expect(back2).toBe(positions[0]) // lands exactly back on the first section
})

test('home below-the-fold sections rise in on scroll (§24.147)', async ({ page }) => {
  await page.goto('/')
  const teaser = page.getByTestId('home-teaser')
  // Wait until the hook has ARMED it (the IntersectionObserver is now observing the
  // below-fold section) but it hasn't revealed yet — then a scroll is a genuine
  // intersection change. It's a child-stagger section, so the trigger lives in the
  // class (its columns move, not the section block).
  await expect(teaser).toHaveClass(/cp-reveal(\s|$)/)
  await expect(teaser).not.toHaveClass(/cp-reveal-in/)
  // Scroll it into view → the once-reveal fires and the class settles to -in.
  await teaser.scrollIntoViewIfNeeded()
  await expect(teaser).toHaveClass(/cp-reveal-in/)

  // The pitch capability list is a child-stagger whose reveal is observed on the
  // LIST, not the section — so the cascade triggers when the list enters view, not
  // while it's still below the fold behind the intro paragraph (§24.147 fu fix).
  const pitchList = page.getByTestId('home-pitch-list')
  await pitchList.scrollIntoViewIfNeeded()
  await expect(pitchList).toHaveClass(/cp-reveal-in/)
})

test('key mobile surfaces are axe-clean (incl. the open nav menu)', async ({ page }) => {
  await page.goto('/')
  await openMenu(page)
  const home = await new AxeBuilder({ page }).analyze()
  expect(home.violations).toEqual([])

  await gotoStable(page, '/dashboard')
  const live = await new AxeBuilder({ page }).analyze()
  expect(live.violations).toEqual([])
})

// ── @visual mobile baselines (skipped in CI; OS-specific) ────────────────────

test('mobile home matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  // Reduced-motion disables the §24.147 scroll reveal (sections stay solid), so the
  // fullPage capture is deterministic — no IntersectionObserver-timing dependence.
  // See the desktop home note.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByTestId('live-ticker')).toContainText('research-company')
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-home.png', {
    animations: 'disabled',
    fullPage: true,
    // Wall-clock-derived hero stat line (drifts daily) — masked; see the desktop note.
    mask: [page.getByTestId('hero-stats')],
  })
})

test('mobile nav menu (open) matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/')
  await openMenu(page)
  // Viewport (not fullPage) so the snapshot frames the header + the open menu.
  await expect(page).toHaveScreenshot('mobile-nav-open.png', { animations: 'disabled' })
})

test('mobile pipeline matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/pipeline')
  await expect(page.getByTestId('funnel-board')).toBeVisible()
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-pipeline.png', {
    animations: 'disabled',
    fullPage: true,
    mask: [page.getByTestId('funnel-card-age'), page.getByTestId('stat-value')],
  })
})

test('mobile kit dossier (sealed) matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/kit?app=ai-infra-a&round=TECH_SCREEN')
  await expect(page.getByTestId('kit-banner-sealed')).toBeVisible()
  await expect(page.getByTestId('kit-sealed-grounding')).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-kit-sealed.png', { animations: 'disabled', fullPage: true })
})

test('mobile architecture matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/architecture')
  await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
  await expect(page).toHaveScreenshot('mobile-architecture.png', { animations: 'disabled', fullPage: true })
})

test('mobile live matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page.getByTestId('trace-stream')).toBeVisible()
  await expect(page.getByTestId('trace-stream').getByText('research-company')).toBeVisible()
  await expect(page.getByTestId('funnel-compact-reveal')).toContainText('Wayne Enterprises')
  await expect(page).toHaveScreenshot('mobile-live.png', {
    animations: 'disabled',
    fullPage: true,
    // Recent-outcomes day stamps drift off the relative seed — masked (§24.147).
    mask: [page.getByTestId('live-volatile'), page.getByTestId('recent-outcome-date')],
  })
})
