import { expect, test } from '@playwright/test'

// Visual-regression guard. Pixel baselines are a *regression* guard only (they
// can't tell a broken first render from a good one — that's what smoke.spec.ts'
// semantic + a11y checks are for). Animations are disabled for determinism.
//
// Tagged @visual so CI (Linux) skips it: screenshot baselines are OS-specific
// (font hinting differs), and the committed baseline is generated on the dev
// OS. The semantic + a11y E2E is the cross-platform gate that runs everywhere.
test('home page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  // Reduced-motion makes the §24.147 scroll reveal not arm (useReveal leaves every
  // section solid), so the fullPage capture is deterministic without depending on
  // IntersectionObserver firing for below-fold content under `captureBeyondViewport`.
  // The reveal's settled state IS this layout (opacity 1, no transform), so the
  // baseline still guards it. Same technique as the sanitizer-modal test below.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeVisible()
  // Wait for the seeded backlog (ticker) + the funnel strip (the public OFFER)
  // to render so the snapshot is deterministic.
  await expect(page.getByTestId('live-ticker')).toContainText('research-company')
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('home.png', {
    animations: 'disabled',
    fullPage: true,
    // The hero stat line is wall-clock-derived ("N agent actions in 24h",
    // "last activity X ago") and drifts daily; mask it (its values are covered by
    // the hero-stats unit tests + the SSR-seed check). The layout is the guard.
    mask: [page.getByTestId('hero-stats')],
  })
})

test('about page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/about')
  await expect(page.getByRole('heading', { name: /why i built this/i, level: 1 })).toBeVisible()
  // Wait for the registry-backed cast roster to render (the page's richest block).
  await expect(page.getByTestId('about-cast')).toContainText('research-company')
  await expect(page).toHaveScreenshot('about.png', { animations: 'disabled', fullPage: true })
})

test('work page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/experience')
  await expect(page.getByRole('heading', { name: 'Jane Doe', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Experience', level: 2 })).toBeVisible()
  await expect(page).toHaveScreenshot('work.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('funnel page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/pipeline')
  await expect(page.getByRole('heading', { name: 'My Job Pipeline', level: 1 })).toBeVisible()
  // Wait for the board to render from the seeded API so the snapshot is stable.
  await expect(page.getByTestId('funnel-board')).toBeVisible()
  await expect(page.getByText('Wayne Enterprises')).toBeVisible()
  await expect(page).toHaveScreenshot('funnel.png', {
    animations: 'disabled',
    fullPage: true,
    // Day-counts + date-windowed stat values derive from wall-clock and drift
    // daily; mask them (the layout is the regression guard, the numbers are
    // covered by the unit + semantic tests).
    mask: [page.getByTestId('funnel-card-age'), page.getByTestId('stat-value')],
  })
})

test('kit dossier (revealed) matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  // The public OFFER's kit — full content, both parts, no masks needed (the
  // fixture's interview dates are fixed; nothing wall-clock-derived renders).
  await page.goto('/kit?app=Wayne%20Enterprises&round=TECH_SCREEN')
  await expect(page.getByTestId('kit-banner-public')).toBeVisible()
  await expect(page.getByTestId('kit-section-gap-notes')).toBeVisible()
  await expect(page).toHaveScreenshot('kit-public.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('kit dossier (sealed) matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  // The live obfuscated app's kit — the redaction-bar skeleton (deterministic
  // per-index bar widths, §24.65).
  await page.goto('/kit?app=ai-infra-a&round=TECH_SCREEN')
  await expect(page.getByTestId('kit-banner-sealed')).toBeVisible()
  await expect(page.getByTestId('kit-sealed-grounding')).toBeVisible()
  await expect(page).toHaveScreenshot('kit-sealed.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('architecture page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/architecture')
  await expect(page.getByRole('heading', { name: 'Architecture', level: 1 })).toBeVisible()
  // Wait for the map to render from the seeded endpoints; every value is fixed
  // (seeded sessions + a fixed container count + seeded modes), so unlike the
  // funnel there's nothing wall-clock-derived to mask.
  await expect(page.getByTestId('arch-diagram')).toBeVisible()
  await expect(page.getByTestId('arch-node-host-router')).toHaveAttribute('data-status', 'healthy')
  await expect(page).toHaveScreenshot('architecture.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('architecture sanitizer-node modal matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  // reduced-motion makes the grow instant, so the modal is in its final centered
  // state for the snapshot (the grow itself is verified manually via the MCP).
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/architecture')
  await expect(page.getByTestId('arch-diagram')).toBeVisible()
  // Open the pub-sanitize node modal; reducedMotion (config) makes the grow
  // instant, so the modal is in its final centered state for the snapshot.
  await page.getByTestId('arch-node-pub-sanitize').click()
  const modal = page.getByRole('dialog', { name: 'Sanitization' })
  // §24.134d: the sanitized pane renders provenance chips, not literal tokens —
  // wait on a chip so the snapshot is stable.
  await expect(modal.getByTestId('anon-sanitized').getByTestId('redaction-chip').first()).toBeVisible()
  await expect(page).toHaveScreenshot('architecture-sanitizer-modal.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('live page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
  // Wait for the SSE trace to replay the seeded backlog so the centerpiece is
  // populated before the snapshot (mirrors the home-ticker wait). The funnel,
  // sessions, container, and recent-outcomes panels are fixed-seed deterministic;
  // Portkey is unmocked here so telemetry/cost render the honest empty state.
  await expect(page.getByTestId('trace-stream')).toBeVisible()
  await expect(page.getByTestId('trace-stream').getByText('research-company')).toBeVisible()
  // Wait for the funnel poll so the right-rail compact funnel + recent outcomes
  // are populated before the snapshot (the anon demo moved to /architecture's
  // sanitizer-node modal in §24.35 Pass B).
  await expect(page.getByTestId('funnel-compact-reveal')).toContainText('Wayne Enterprises')
  await expect(page).toHaveScreenshot('live.png', {
    animations: 'disabled',
    fullPage: true,
    // The local-aggregate line is wall-clock-windowed (and could shift if a
    // parallel spec pushed an audit row); the layout is the regression guard,
    // the numbers are covered by the unit + semantic tests. The Recent-outcomes
    // day stamps (§24.147) derive from a relative seed (`isoDaysAgo`) so they
    // drift daily — masked too; the date FORMAT is covered by the panels unit test.
    mask: [page.getByTestId('live-volatile'), page.getByTestId('recent-outcome-date')],
  })
})

// §24.36 36.1 — async-state baselines, reachable via the mock-only `?__state`
// override. These are the regression guard for the shared loading/empty/error
// language; `animations:'disabled'` freezes the skeleton pulse + the connecting
// cursor at a deterministic frame.
test('funnel loading state matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/pipeline?__state=loading')
  await expect(page.getByTestId('funnel-skeleton')).toBeVisible()
  await expect(page).toHaveScreenshot('funnel-loading.png', { animations: 'disabled', fullPage: true })
})

test('funnel empty state matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/pipeline?__state=empty')
  await expect(page.getByTestId('funnel-empty')).toBeVisible()
  await expect(page).toHaveScreenshot('funnel-empty.png', { animations: 'disabled', fullPage: true })
})

test('funnel error state matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/pipeline?__state=error')
  await expect(page.getByTestId('funnel-error')).toBeVisible()
  await expect(page).toHaveScreenshot('funnel-error.png', { animations: 'disabled', fullPage: true })
})

test('architecture loading state matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/architecture?__state=loading')
  await expect(page.getByTestId('arch-skeleton')).toBeVisible()
  await expect(page).toHaveScreenshot('architecture-loading.png', { animations: 'disabled', fullPage: true })
})

test('live loading state matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/dashboard?__state=loading')
  await expect(page.getByTestId('panel-skeleton').first()).toBeVisible()
  await expect(page.getByTestId('trace-empty')).toContainText(/connecting/i)
  await expect(page).toHaveScreenshot('live-loading.png', { animations: 'disabled', fullPage: true })
})

// §24.36 36.3 — the recoverable error boundary, reached via the mock-only
// /crash synthetic-crash route (armed by VITE_MOCK_SEAM in the E2E build). The
// raw error detail is dev-only, so this prod-build render is deterministic.
test('route error boundary matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/crash')
  await expect(page.getByTestId('route-error')).toBeVisible()
  await expect(page).toHaveScreenshot('error-boundary.png', { animations: 'disabled', fullPage: true })
})

// §24.36 36.5 — the styled 404 (the on-brand sibling of the error boundary).
test('404 page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/this-route-does-not-exist')
  await expect(page.getByTestId('not-found')).toBeVisible()
  await expect(page).toHaveScreenshot('not-found.png', { animations: 'disabled', fullPage: true })
})

test('contact page matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/contact')
  await expect(page.getByRole('heading', { name: 'Talk to me', level: 1 })).toBeVisible()
  // The empty form (default state) — fully static, nothing wall-clock-derived.
  await expect(page.getByTestId('contact-form')).toBeVisible()
  // §24.120: the "Open to offers" pill's dot is SSE-status-driven (green/pulsing
  // when live, muted when not), so wait for the live state before capture — else
  // the dot color flakes idle↔open. The pulse animation itself is frozen by
  // `animations:'disabled'`; only the steady color matters to the baseline.
  await expect(page.getByTestId('contact-status')).toHaveAttribute('data-status', 'open')
  await expect(page).toHaveScreenshot('contact.png', {
    animations: 'disabled',
    fullPage: true,
  })
})

test('simulator input view matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/watch')
  await expect(page.getByRole('heading', { name: /watch me apply to your role/i, level: 1 })).toBeVisible()
  // The pre-run Apple-register input view — fully static (the timing-dependent
  // mid-run streaming view is covered by the semantic E2E, not a snapshot).
  await expect(page.getByTestId('sim-input-form')).toBeVisible()
  await expect(page).toHaveScreenshot('simulator-input.png', {
    animations: 'disabled',
    fullPage: true,
    // Small tolerance for sub-pixel font antialiasing — this static form
    // occasionally flakes by a handful of pixels at one glyph cluster across
    // separate renders; the layout is the regression guard, not glyph edges.
    maxDiffPixels: 200,
  })
})

test('simulator share results matches visual baseline', { tag: '@visual' }, async ({ page }) => {
  await page.goto('/watch/results/det-sim-1')
  // The seeded, far-future-expiry shareable run — deterministic (no streaming).
  await expect(page.getByRole('heading', { name: /Principal Engineer @ Wayne Enterprises/i, level: 1 })).toBeVisible()
  await expect(page.getByTestId('sim-outreach')).toBeVisible()
  await expect(page).toHaveScreenshot('simulator-results.png', {
    animations: 'disabled',
    fullPage: true,
  })
})
