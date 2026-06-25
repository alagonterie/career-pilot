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
      // Deliberately long (many lines) so the line-clamp is exercised — a verbose
      // submission must not blow out the row height / table width.
      message:
        'We are hiring for a senior backend role and your portfolio is exactly what we are looking for. ' +
        'The team ships a high-throughput payments platform and we loved the agent system you built here. ' +
        'Would you be open to a 30-minute intro call this week or next? We can work around your schedule. ' +
        'Reply any time — looking forward to it.',
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

// §24.164: the owner-only Sandbox-runs feed (the admin page polls it on every tab).
const SANDBOX_RUNS = {
  runs: [
    {
      id: 'sb-e2e-1',
      ts: '2026-06-23T17:00:00.000Z',
      visitor_company: 'Globex',
      visitor_role: 'Staff SWE',
      jd_excerpt: 'Build the reconciliation service',
      total_cost_cents: 84,
      total_latency_ms: 153000,
      status: 'completed',
      expires_at: null,
      ip_token: 'abcdef0123456789',
    },
  ],
  stats: { total: 1, runsToday: 1, costTodayCents: 84, runs7d: 1 },
}

const PERSONA = {
  fields: {
    full_name: 'Jane Doe',
    display_name: 'Jane',
    bio: 'Engineer',
    target_roles: JSON.stringify(['Staff Eng']),
    skills: JSON.stringify(['Go']),
    location_pref: '{"remote":true}',
    comp_floor: 185000,
    search_goals: 'staff role',
    master_resume: 'resume',
    github_url: null,
    linkedin_url: null,
    x_url: null,
    website_url: null,
    public_email: null,
    brand_color_hsl: null,
    headshot_path: null,
    protected_terms: JSON.stringify([]),
    gmail_account: 'jane@gmail.com',
  },
  readonlyFields: ['gmail_account'],
  workProfile: { json: '{"name":"Jane Doe"}', source: 'seed', generated_at: '2026-06-24T00:00:00.000Z' },
  personaPreview: '# Jane Doe',
  blockers: [],
}

const LEADS = {
  rollup: {
    activeTotal: 2,
    closedTotal: 1,
    byStatus: { new: 1, reviewed: 1 },
    bySource: { greenhouse: 2 },
    llmScored: 1,
    pushed24h: 0,
    added24h: 1,
    added7d: 2,
    newestAgeHours: 5,
  },
  leads: [
    {
      id: 'lead-1',
      source: 'greenhouse',
      source_url: 'https://x/1',
      apply_url: null,
      title: 'Senior Software Engineer',
      company: 'Globex',
      company_domain: null,
      location_raw: 'Remote',
      is_remote: 1,
      workplace_type: 'remote',
      comp_min_usd: 180000,
      comp_max_usd: 220000,
      comp_currency: 'USD',
      comp_period: 'year',
      rules_score: 82,
      rules_score_reasons: {
        keyword_match: { score: 15, title_hits: 1, desc_hits: 2, matched: ['Go'] },
        comp: { score: 20, floor: 170000 },
        location: { score: 8, is_remote: true },
        recency: { score: 15, age_hours: 3 },
        source_mult: { source: 'greenhouse', multiplier: 1.1 },
      },
      llm_score: 74,
      llm_scored_at: '2026-06-24T00:00:00Z',
      status: 'reviewed',
      status_changed_at: '2026-06-24T00:00:00Z',
      first_seen_at: '2026-06-24T00:00:00Z',
      last_seen_at: '2026-06-24T00:00:00Z',
      source_posted_at: '2026-06-24T00:00:00Z',
      closed_at: null,
      closed_reason: null,
      killer_match_pushed_at: null,
      application_id: null,
      snippet: 'Build distributed systems',
    },
    {
      id: 'lead-2',
      source: 'greenhouse',
      source_url: 'https://x/2',
      apply_url: null,
      title: 'Backend Engineer',
      company: 'Initech',
      company_domain: null,
      location_raw: 'NYC',
      is_remote: 0,
      workplace_type: 'onsite',
      comp_min_usd: null,
      comp_max_usd: null,
      comp_currency: 'USD',
      comp_period: null,
      rules_score: 40,
      rules_score_reasons: { keyword_match: { score: 15 }, location: { score: -30, off_location: true } },
      llm_score: null,
      llm_scored_at: null,
      status: 'new',
      status_changed_at: '2026-06-25T00:00:00Z',
      first_seen_at: '2026-06-25T00:00:00Z',
      last_seen_at: '2026-06-25T00:00:00Z',
      source_posted_at: '2026-06-25T00:00:00Z',
      closed_at: null,
      closed_reason: null,
      killer_match_pushed_at: null,
      application_id: null,
      snippet: null,
    },
  ],
  closed: [
    {
      id: 'lead-3',
      source: 'greenhouse',
      source_url: 'https://x/3',
      apply_url: null,
      title: 'Platform Engineer',
      company: 'Hooli',
      company_domain: null,
      location_raw: null,
      is_remote: null,
      workplace_type: null,
      comp_min_usd: null,
      comp_max_usd: null,
      comp_currency: 'USD',
      comp_period: null,
      rules_score: 60,
      rules_score_reasons: {},
      llm_score: null,
      llm_scored_at: null,
      status: 'archived',
      status_changed_at: '2026-06-22T00:00:00Z',
      first_seen_at: '2026-06-20T00:00:00Z',
      last_seen_at: '2026-06-20T00:00:00Z',
      source_posted_at: null,
      closed_at: '2026-06-22T00:00:00Z',
      closed_reason: 'stale',
      killer_match_pushed_at: null,
      application_id: null,
      snippet: null,
    },
  ],
}

/** Stub the admin reads (+ the knob/control/sandbox POSTs). `available:false` → every read 404s. */
async function stubAdmin(page: Page, available = true): Promise<void> {
  const read = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill(available ? jsonRoute(body) : jsonRoute({ error: 'not_found' }, 404))

  await page.route('**/api/admin/summary', read(SUMMARY))
  await page.route('**/api/admin/pipeline', read(PIPELINE))
  await page.route('**/api/admin/contacts', read(CONTACTS))
  await page.route('**/api/admin/attribution', read(ATTRIBUTION))
  await page.route('**/api/admin/sandbox-runs', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ deleted: true }, 200))
    return route.fulfill(available ? jsonRoute(SANDBOX_RUNS) : jsonRoute({ error: 'not_found' }, 404))
  })
  await page.route('**/api/admin/knobs', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ applied: true }, 200))
    return route.fulfill(available ? jsonRoute(KNOBS) : jsonRoute({ error: 'not_found' }, 404))
  })
  await page.route('**/api/admin/control', (route) => route.fulfill(jsonRoute({ liveMode: true }, 200)))
  await page.route('**/api/admin/persona', read(PERSONA))
  await page.route('**/api/admin/leads', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ ok: true }, 200))
    return route.fulfill(available ? jsonRoute(LEADS) : jsonRoute({ error: 'not_found' }, 404))
  })
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
    // The long message is line-clamped: the rendered box is bounded to ~3 lines and
    // the full content is clipped (scrollHeight exceeds it). A behavioral check —
    // Chromium normalizes the `-webkit-box` display keyword in getComputedStyle, so
    // asserting the keyword is unreliable; the height bound is the real contract.
    const msg = page.getByTestId('admin-contact-message')
    const clamp = await msg.evaluate((el) => ({ clientH: el.clientHeight, scrollH: el.scrollHeight }))
    expect(clamp.scrollH).toBeGreaterThan(clamp.clientH + 1) // content is clipped
    expect(clamp.clientH).toBeLessThan(96) // ~3 lines, not the full ~7-line message

    // Visitors tab: the attribution browser.
    await page.getByTestId('admin-tab-visitors').click()
    await expect(page.getByText('anthropic.com').first()).toBeVisible()

    // Sandbox tab: the §24.164 owner runs view (migrated onto DataTable §24.174).
    await page.getByTestId('admin-tab-sandbox').click()
    await expect(page.getByTestId('sandbox-run-sb-e2e-1')).toBeVisible()
    await expect(page.getByTestId('sandbox-run-open-sb-e2e-1')).toHaveAttribute('href', '/watch/results/sb-e2e-1')

    // System tab: the knob grid (registry − ADMIN_DENY).
    await page.getByTestId('admin-tab-system').click()
    await expect(page.getByTestId('knob-group-simulator')).toBeVisible()
    await expect(page.getByTestId('knob-simulator_enabled').getByRole('switch')).toBeVisible()

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(consoleErrors).toEqual([])
  })

  test('the Leads tab shows the pool rollup + a lead with its score-reasons breakdown (§24.173)', async ({ page }) => {
    await stubAdmin(page)
    await page.goto('/admin')
    await page.getByTestId('admin-tab-leads').click()

    await expect(page.getByTestId('leads-panel')).toBeVisible()
    await expect(page.getByTestId('leads-rollup')).toContainText('Active')
    // active-only by default → 2 rows; sorted rules_score DESC (Globex 82 first).
    await expect(page.getByTestId('leads-row')).toHaveCount(2)

    // expand the top lead → its rules_score reasons breakdown (the "why").
    await page.getByTestId('leads-row').first().click()
    await expect(page.getByTestId('leads-detail')).toBeVisible()
    await expect(page.getByTestId('leads-score-reasons')).toContainText('keyword')

    // include-closed reveals the archived lead.
    await page.getByTestId('leads-include-closed').check()
    await expect(page.getByTestId('leads-row')).toHaveCount(3)
  })

  test('the active tab is URL-driven — deep-link + back/forward (§24.176)', async ({ page }) => {
    await stubAdmin(page)

    // Deep-link straight to a tab (SSR/first paint honors ?tab=).
    await page.goto('/admin?tab=leads')
    await expect(page.getByTestId('leads-panel')).toBeVisible()

    // Clicking a tab writes the param; overview clears it (clean /admin).
    await page.getByTestId('admin-tab-contacts').click()
    await expect(page).toHaveURL(/[?&]tab=contacts/)
    await expect(page.getByTestId('admin-contact-row')).toBeVisible()

    // Back returns to the previous tab (history works).
    await page.goBack()
    await expect(page).toHaveURL(/[?&]tab=leads/)
    await expect(page.getByTestId('leads-panel')).toBeVisible()
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
