import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// /admin (§24.138) is owner-gated: every `/api/admin/*` endpoint 404s unless the
// admin surface is enabled (open on dev; prod fails closed). The E2E server isn't
// that stack, so — like /dev — we stub the reads via page.route and test the
// page's own logic: the tabbed IA, a knob write round-trip, the confirm-gated mode
// controls, and the prod-degradation ("unavailable") path.

const SUMMARY = {
  mode: { live_mode: false, pause_state: 'active', pause_reason: null, backend: 'online' },
  health: {
    ranAt: '2026-06-20T10:00:00.000Z',
    counts: { ok: 4, warn: 1, critical: 0 },
    worst: 'warn',
    findings: [
      {
        id: 'delivery-backlog',
        severity: 'warn',
        title: 'Outbound delivery backlog',
        detail: '12 undelivered rows older than the threshold.',
        next_step: 'pnpm health --json',
      },
    ],
  },
  spendByClass: {
    ops: { microusd_24h: 120000, buckets: [] },
    chat: { microusd_24h: 210000, buckets: [] },
    sandbox: { microusd_24h: 50000, buckets: [] },
    host: { microusd_24h: 0, buckets: [] },
  },
  spendTotalMicrousd24h: 380000,
  pool: { active: 2, capacity: 4 },
}

const PIPELINE = {
  applications: [
    {
      application_id: 'app-1',
      company_name: 'Wayne Enterprises',
      obfuscated_label: 'infra-e',
      role_title: 'Staff Engineer',
      status: 'screening',
      stage: 'screen',
      applied_at: '2026-06-10T00:00:00.000Z',
      last_activity_at: '2026-06-18T00:00:00.000Z',
      win_confidence: 68,
    },
  ],
  stageCounts: { screen: 1 },
}

const CONTACTS = {
  contacts: [
    {
      id: 'c1',
      name: 'Sam Recruiter',
      email: 'sam@acme.example',
      company: 'Acme',
      role: 'Staff Eng',
      source: 'portal',
      message: 'We are hiring — let’s talk.',
      delivered: 1,
      createdAt: '2026-06-19T10:00:00.000Z',
    },
  ],
}

const KNOBS = {
  knobs: [
    {
      key: 'simulator_enabled',
      value: false,
      default: true,
      overridden: true,
      type: 'boolean',
      group: 'simulator',
      label: 'Simulator enabled',
      min: null,
      max: null,
      integer: false,
      options: null,
      maxLength: null,
      note: 'The public demo kill switch.',
    },
    {
      key: 'owner_daily_llm_budget_usd',
      value: 5,
      default: 5,
      overridden: false,
      type: 'number',
      group: 'budget',
      label: 'Owner daily LLM budget (USD)',
      min: 0,
      max: 1000,
      integer: false,
      options: null,
      maxLength: null,
      note: null,
    },
  ],
}

const ATTRIBUTION = {
  links: [
    {
      code: 'out1',
      artifactType: 'outreach',
      company: 'anthropic.com',
      recipient: 'jane@anthropic.com',
      createdAt: '2026-06-16T10:00:00.000Z',
      clicks: 3,
      uniqueVisitors: 2,
      lastClickAt: '2026-06-16T12:00:00.000Z',
    },
  ],
  recentVisits: [
    {
      ts: '2026-06-16T12:00:00.000Z',
      linkCode: 'out1',
      company: 'anthropic.com',
      country: 'US',
      uaClass: 'desktop',
      referrer: null,
    },
  ],
  summary: {
    totalLinks: 1,
    totalClicks: 3,
    totalUniqueVisitors: 2,
    byArtifact: { outreach: 1 },
    topCountries: [{ country: 'US', clicks: 3 }],
  },
}

function jsonRoute(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

/** Stub the five reads (+ the knob/control POSTs). `available:false` → every read 404s. */
async function stubAdmin(page: Page, available = true): Promise<void> {
  const read = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill(available ? jsonRoute(body) : jsonRoute({ error: 'not_found' }, 404))

  await page.route('**/api/admin/summary', read(SUMMARY))
  await page.route('**/api/admin/pipeline', read(PIPELINE))
  await page.route('**/api/admin/contacts', read(CONTACTS))
  await page.route('**/api/admin/attribution', read(ATTRIBUTION))
  await page.route('**/api/admin/knobs', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ applied: true }, 200))
    return route.fulfill(available ? jsonRoute(KNOBS) : jsonRoute({ error: 'not_found' }, 404))
  })
  await page.route('**/api/admin/control', (route) => route.fulfill(jsonRoute({ liveMode: true }, 200)))
}

test.describe('/admin — control center (§24.138)', () => {
  test('renders the Overview rollup + the tabbed panels from the stubbed API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await stubAdmin(page)
    await page.goto('/admin')

    await expect(page.getByRole('heading', { level: 1, name: 'Control center' })).toBeVisible()

    // Overview (default tab): mode + run-state badges, health, cost, pool.
    await expect(page.getByTestId('admin-live-badge')).toContainText('SHADOW')
    await expect(page.getByTestId('admin-run-badge')).toContainText('RUNNING')
    await expect(page.getByTestId('admin-health-counts')).toContainText('warn 1')
    await expect(page.getByTestId('admin-health-finding')).toContainText('Outbound delivery backlog')
    await expect(page.getByTestId('admin-spend-total')).toHaveText('$0.38')
    await expect(page.getByTestId('admin-spend-chat')).toHaveText('$0.21')
    await expect(page.getByTestId('admin-pool')).toHaveText('2 / 4')

    // Pipeline tab: the owner view shows the REAL company name.
    await page.getByTestId('admin-tab-pipeline').click()
    await expect(page.getByText('Wayne Enterprises')).toBeVisible()
    await expect(page.getByText('infra-e')).toBeVisible()

    // Contacts tab: the §24.121 store.
    await page.getByTestId('admin-tab-contacts').click()
    await expect(page.getByTestId('admin-contact-row')).toContainText('sam@acme.example')

    // Visitors tab: the attribution browser.
    await page.getByTestId('admin-tab-visitors').click()
    await expect(page.getByText('anthropic.com').first()).toBeVisible()

    // System tab: the knob grid (registry − ADMIN_DENY).
    await page.getByTestId('admin-tab-system').click()
    await expect(page.getByTestId('knob-group-simulator')).toBeVisible()
    await expect(page.getByTestId('knob-simulator_enabled').getByRole('switch')).toBeVisible()

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(consoleErrors).toEqual([])
  })

  test('a System-tab knob toggle POSTs the flipped value to /api/admin/knobs', async ({ page }) => {
    await stubAdmin(page)
    await page.goto('/admin')
    await page.getByTestId('admin-tab-system').click()

    const sw = page.getByTestId('knob-simulator_enabled').getByRole('switch')
    await expect(sw).toHaveAttribute('aria-checked', 'false')

    const reqP = page.waitForRequest((r) => r.url().includes('/api/admin/knobs') && r.method() === 'POST')
    await sw.click()
    expect((await reqP).postDataJSON()).toEqual({ key: 'simulator_enabled', value: true })
  })

  test('Go LIVE is confirm-gated and POSTs { set_live_mode, on, confirm } to /api/admin/control', async ({ page }) => {
    await stubAdmin(page)
    await page.goto('/admin')

    // The bare click only opens the confirm — no POST yet.
    await page.getByTestId('admin-live-btn').click()
    await expect(page.getByTestId('admin-confirm')).toBeVisible()

    const reqP = page.waitForRequest((r) => r.url().includes('/api/admin/control') && r.method() === 'POST')
    await page.getByTestId('admin-confirm-yes').click()
    expect((await reqP).postDataJSON()).toEqual({ action: 'set_live_mode', on: true, confirm: true })
  })

  test('degrades to an "unavailable" note when the endpoints 404 (gated stack)', async ({ page }) => {
    await stubAdmin(page, false)
    await page.goto('/admin')

    await expect(page.getByTestId('admin-unavailable')).toBeVisible()
    await expect(page.getByTestId('admin-unavailable')).toContainText('Cloudflare Access')
    // No controls / no tabs rendered.
    await expect(page.getByTestId('admin-mode-controls')).toHaveCount(0)
    await expect(page.getByTestId('admin-tab-system')).toHaveCount(0)
  })
})
