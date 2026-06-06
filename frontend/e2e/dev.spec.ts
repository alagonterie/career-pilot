import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// /dev (§24.42c) is dev-only: the backend `/api/dev/*` endpoints 404 unless
// ENVIRONMENT==='dev'. The E2E server doesn't run as the dev stack, so we stub
// the endpoints via page.route (the spec's sanctioned "endpoints stubbed" path)
// — deterministic and decoupled from server env. What's under test is the
// page's own logic: the grouped controls, a write round-trip, and the
// prod-degradation ("unavailable") path when the endpoints 404.

const KNOBS = {
  knobs: [
    {
      key: 'recruiter_sim_enabled',
      value: false,
      default: false,
      overridden: false,
      type: 'boolean',
      group: 'sim',
      label: 'Sim enabled',
      min: null,
      max: null,
      integer: false,
      note: null,
    },
    {
      // overridden (value 2 ≠ default 8) so the reset controls are exercised.
      key: 'recruiter_sim_max_concurrent',
      value: 2,
      default: 8,
      overridden: true,
      type: 'number',
      group: 'sim',
      label: 'Max concurrent',
      min: 0,
      max: 100,
      integer: true,
      note: null,
    },
    {
      key: 'funnel_curator_cron',
      value: '30 7 * * *',
      default: '30 7 * * *',
      overridden: false,
      type: 'cron',
      group: 'pacing',
      label: 'Funnel cron',
      min: null,
      max: null,
      integer: false,
      note: 'Applies on the next reclone.',
    },
  ],
}

const STATE = {
  enabled: false,
  lastSeedAtMs: 0,
  pauseState: 'active',
  apps: [
    {
      appId: 'sim-1',
      company: 'Meridian Labs',
      role: 'Senior Software Engineer',
      obfuscatedLabel: 'ai-a',
      threadId: 't1',
      stageIndex: 2,
      totalStages: 4,
      upcoming: 'onsite_invite',
      status: 'active',
      outcome: null,
      nextFireAtMs: Date.now() + 120000,
    },
  ],
  applications: [
    {
      id: 'sim-1',
      company_name: 'Meridian Labs',
      obfuscated_label: 'ai-a',
      role_title: 'Senior Software Engineer',
      status: 'screening',
      applied_at: '2026-05-09T00:00:00Z',
      last_activity_at: null,
    },
  ],
}

const PERSONA = {
  profile: null,
  candidateMd: '# Onboarding mode\n\nNo candidate profile yet.',
  onboarding: {
    fields: [
      { field: 'full_name', filled: false },
      { field: 'target_roles', filled: false },
      { field: 'comp_floor', filled: false },
      { field: 'master_resume', filled: false },
      { field: 'bio', filled: false },
      { field: 'why_this_exists', filled: false },
    ],
    filledCount: 0,
    totalCount: 6,
    complete: false,
    nextField: 'full_name',
  },
}

function jsonRoute(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

/** Stub the three reads (+ the knob POST). `available:false` → every read 404s. */
async function stubDev(page: Page, available = true): Promise<void> {
  await page.route('**/api/dev/knobs', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill(jsonRoute({ applied: true }, 200))
    }
    return route.fulfill(available ? jsonRoute(KNOBS) : jsonRoute({ error: 'not_found' }, 404))
  })
  await page.route('**/api/dev/state', (route) =>
    route.fulfill(available ? jsonRoute(STATE) : jsonRoute({ error: 'not_found' }, 404)),
  )
  await page.route('**/api/dev/persona', (route) =>
    route.fulfill(available ? jsonRoute(PERSONA) : jsonRoute({ error: 'not_found' }, 404)),
  )
}

test.describe('/dev — dev inspector + sim controls (§24.42c)', () => {
  test('renders the grouped controls + sim + persona panels from the stubbed API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await stubDev(page)
    await page.goto('/dev')

    await expect(page.getByRole('heading', { level: 1, name: 'Dev inspector' })).toBeVisible()

    // Grouped controls.
    await expect(page.getByTestId('knob-group-sim')).toBeVisible()
    await expect(page.getByTestId('knob-group-pacing')).toBeVisible()
    await expect(page.getByTestId('knob-recruiter_sim_enabled').getByRole('switch')).toBeVisible()

    // Sim panel: joined DB status + what the sim has queued next.
    const simRow = page.getByTestId('sim-app-sim-1')
    await expect(simRow.getByText('Meridian Labs')).toBeVisible()
    await expect(simRow.getByText('screening')).toBeVisible()
    await expect(page.getByTestId('sim-next-sim-1')).toContainText('onsite_invite')

    // Persona panel: onboarding mode (next = full_name) + the rendered sentinel.
    await expect(page.getByTestId('onboarding-badge')).toContainText('0/6')
    await expect(page.getByTestId('onboarding-full_name')).toContainText('next')
    await expect(page.getByTestId('candidate-md')).toContainText('Onboarding mode')

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(consoleErrors).toEqual([])
  })

  test('toggling the sim switch POSTs the flipped value to /api/dev/knobs', async ({ page }) => {
    await stubDev(page)
    await page.goto('/dev')

    const sw = page.getByTestId('knob-recruiter_sim_enabled').getByRole('switch')
    await expect(sw).toHaveAttribute('aria-checked', 'false')

    const reqP = page.waitForRequest((r) => r.url().includes('/api/dev/knobs') && r.method() === 'POST')
    await sw.click()
    const req = await reqP
    expect(req.postDataJSON()).toEqual({ key: 'recruiter_sim_enabled', value: true })
  })

  test('a per-knob reset POSTs { key, reset } and "All to defaults" POSTs { resetAll }', async ({ page }) => {
    await stubDev(page)
    await page.goto('/dev')

    // The overridden knob shows a reset control; the rest do not.
    await expect(page.getByTestId('knob-reset-recruiter_sim_max_concurrent')).toBeVisible()
    await expect(page.getByTestId('knob-reset-recruiter_sim_enabled')).toHaveCount(0)

    const resetReq = page.waitForRequest((r) => r.url().includes('/api/dev/knobs') && r.method() === 'POST')
    await page.getByTestId('knob-reset-recruiter_sim_max_concurrent').click()
    expect((await resetReq).postDataJSON()).toEqual({ key: 'recruiter_sim_max_concurrent', reset: true })

    // "All to defaults" is enabled (one knob overridden) and posts resetAll.
    const allReq = page.waitForRequest((r) => r.url().includes('/api/dev/knobs') && r.method() === 'POST')
    await page.getByTestId('reset-all').click()
    expect((await allReq).postDataJSON()).toEqual({ resetAll: true })
  })

  test('degrades to an "unavailable" note when the endpoints 404 (non-dev stack)', async ({ page }) => {
    await stubDev(page, false)
    await page.goto('/dev')

    await expect(page.getByTestId('dev-unavailable')).toBeVisible()
    await expect(page.getByTestId('dev-unavailable')).toContainText('dev stack')
    // No controls / no PII surface rendered.
    await expect(page.getByTestId('knob-group-sim')).toHaveCount(0)
    await expect(page.getByTestId('persona-panel')).toHaveCount(0)
  })

  test('fits an iPhone SE viewport without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }) // iPhone SE
    await stubDev(page)
    await page.goto('/dev')
    await expect(page.getByTestId('knob-group-sim')).toBeVisible()
    // The page must not be wider than the viewport — the long config keys in the
    // knob headers truncate instead of forcing a horizontal scroll.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('is not linked from the public site nav (dev-only, direct URL)', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Primary' })
    await expect(nav.getByRole('link', { name: /dev inspector/i })).toHaveCount(0)
  })
})
