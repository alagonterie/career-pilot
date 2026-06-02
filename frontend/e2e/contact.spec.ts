import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// /contact is the conversion sink (§24.30 / PORTAL §5.7). The E2E server's relay
// has no wired channel, so a real submit returns 503 → the honest error path;
// that still proves the POST round-trip end to end. The success-confirmation UI
// is unit-tested (mocked fetch). The rail + nav reaching the sink (and carrying
// ?from) is the connective-tissue proof.
test.describe('/contact — the conversion sink, frontend <-> backend', () => {
  test('renders, prefills carried context, and round-trips a submit', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      // The test deliberately submits to an unavailable relay (no channel wired
      // in the harness) to prove the error round-trip; the browser's resulting
      // 503 resource-load message is the expected artifact, not a real error.
      if (/status of 503/.test(msg.text())) return
      consoleErrors.push(msg.text())
    })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => {
      if (req.url().includes('/api/')) return // contact POST + polling aborts
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`)
    })

    await page.goto('/contact?company=Acme%20Corp&role=Staff%20Engineer&from=live')

    await expect(page.getByRole('heading', { level: 1, name: 'Talk to me' })).toBeVisible()

    // Carried context: the company/role prefill + the "from" note.
    await expect(page.getByLabel('Company')).toHaveValue('Acme Corp')
    await expect(page.getByLabel('Role / title')).toHaveValue('Staff Engineer')
    await expect(page.getByText(/from the live view/i)).toBeVisible()

    // The sink shows no connective rail (it IS the rail's destination).
    await expect(page.getByTestId('connective-rail')).toHaveCount(0)

    // Fill the rest + submit → the harness relay is unavailable → honest error
    // (proves POST → relay → 503 → UI round-trip).
    await page.getByLabel('Your name').fill('Sam Recruiter')
    await page.getByLabel('Email').fill('sam@acme.com')
    await page.getByLabel(/Message/).fill('We are hiring — let’s talk.')
    await page.getByRole('button', { name: /send/i }).click()
    await expect(page.getByTestId('contact-error')).toBeVisible()

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('the connective rail + nav reach /contact, and convert carries ?from', async ({ page }) => {
    await page.goto('/live')

    // The rail's convert path on /live → /contact?from=live.
    const rail = page.getByTestId('connective-rail')
    await expect(rail).toBeVisible()
    await rail.getByRole('link', { name: /talk to me/i }).click()
    await expect(page).toHaveURL(/\/contact\?from=live/)
    await expect(page.getByRole('heading', { level: 1, name: 'Talk to me' })).toBeVisible()

    // The top nav also reaches the sink.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Contact' }).click()
    await expect(page).toHaveURL('/contact')
  })
})
