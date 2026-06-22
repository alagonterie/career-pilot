import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// `/about` — the story + methodology "tell" surface (PORTAL §5.8 / §24.75).
// Functional + a11y only (cross-platform; the pixel baseline rides the next
// `/` polish pass). Proves: the home pitch beat deepens here; the page renders
// the registry-backed cast + the deep-linkable #anonymization anchor; and the
// connective rail keeps it from dead-ending.
test.describe('/about — story + methodology', () => {
  test('is reached from the home pitch beat and renders the full arc', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // The pitch beat (home Viewport 1.5) carries the only in-page doorway.
    await page.goto('/')
    await page.getByRole('link', { name: /read the full story/i }).click()
    await expect(page).toHaveURL(/\/about$/)

    await expect(page.getByRole('heading', { name: /why i built this/i, level: 1 })).toBeVisible()

    // Meet-the-cast reads from the ai-actors registry (a subagent + the host
    // scorer — proof it's the registry, not a hand-typed list).
    const cast = page.getByTestId('about-cast')
    await expect(cast).toContainText('research-company')
    await expect(cast).toContainText('win-confidence-scorer')

    // The #anonymization anchor target (deep-linked from /experience + the pipeline note).
    await expect(page.locator('#anonymization')).toBeVisible()

    // The shared long-form scaffold (§24.83): a sticky scroll-spy TOC over the
    // prose. On desktop the slim left rail is the one in the a11y tree (the mobile
    // chip strip is display:none) — exact name avoids matching the "(quick nav)" one.
    const toc = page.getByRole('navigation', { name: 'On this page', exact: true })
    await expect(toc).toBeVisible()
    await expect(toc.getByRole('button', { name: 'The story' })).toBeVisible()

    // Tells, doesn't re-draw: it links out to the proof surface + the repo.
    await expect(page.getByRole('link', { name: /live system map/i })).toBeVisible()

    // Not a dead-end: the connective rail's convert path is present.
    const rail = page.getByTestId('connective-rail')
    await expect(rail.getByTestId('rail-convert')).toBeVisible()

    // Let the scaffold's entrance fade settle before the a11y scan (same reason as
    // /experience — Axe can catch a transient sub-threshold contrast mid-fade).
    await expect(page.getByTestId('about-dossier')).toHaveCSS('opacity', '1')

    // Accessibility — recruiter-facing showcase; zero violations.
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(consoleErrors).toEqual([])
  })

  test('is reachable directly at /about#anonymization', async ({ page }) => {
    await page.goto('/about#anonymization')
    await expect(page.getByRole('heading', { name: /why companies are hidden/i, level: 2 })).toBeVisible()

    // §24.153 item 4: the example handle renders as the shared anonymization chip
    // (title-carrying), not a raw quoted token.
    const chip = page.getByText('fintech-b', { exact: true })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('title', /anonymized/i)
  })
})
