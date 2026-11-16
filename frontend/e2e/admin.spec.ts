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
      stage: 'screening',
      applied_at: '2026-06-10T00:00:00.000Z',
      last_activity_at: '2026-06-18T00:00:00.000Z',
      win_confidence: 68,
      // §24.204: the read-only catch-up fields.
      stage_entered_at: '2026-06-06T00:00:00.000Z',
      days_in_stage: 12,
      ghosting_threshold_days: 10,
      ghosting: true,
      win_confidence_rationale: 'Strong platform match; the screen went well.',
      lead_ids: ['lead-1'],
      posting_url: 'https://boards.example.com/wayne/1',
      sent_resume_id: 'tr-1',
      timeline: [
        {
          id: 'ev-1',
          ts: '2026-06-06T00:00:00.000Z',
          kind: 'status_change',
          from_status: 'applied',
          to_status: 'screening',
          source: 'agent',
          summary: 'Recruiter booked a screen',
        },
      ],
      narrative: {
        current_state: 'Waiting on the hiring manager after the screen.',
        last_event_at: '2026-06-06T00:00:00.000Z',
        timeline_excerpt: ['Applied Jun 10', 'Screen Jun 16'],
      },
      suggestions: [{ action: 'draft_followup', rationale: 'Quiet since the screen', evidence_msg_id: null }],
      attention: [{ priority: 'action_owed', reason: 'Follow-up owed', hint: 'Send a short note' }],
      attention_top: 'action_owed',
      last_email: {
        at: '2026-06-16T00:00:00.000Z',
        subject: 'Thanks for your time',
        from_addr: 'recruiter@wayne.example',
        classification: 'interview_followup',
        thread_id: 'thr-1',
        thread_url: 'https://mail.google.com/mail/#all/thr-1',
      },
      learnings: [],
      kits: [],
      active_kit_url: null,
      tailored_resumes: [
        { id: 'tr-1', lead_id: 'lead-1', created_at: '2026-06-09T00:00:00.000Z', bio_outcome: null, sent: true },
      ],
    },
  ],
  stageCounts: { screening: 1 },
  ghostingThresholdsDays: { applied: 21, screen: 10, onsite: 7 },
  ghostingStageMap: { applied: 'applied', screening: 'screen', tech: 'onsite', final: 'onsite' },
  scribe: { run_at: '2026-06-18T06:00:00.000Z', attention_unlinked: [] },
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
      expiresAt: null,
      clicks: 3,
      uniqueVisitors: 2,
      lastClickAt: '2026-06-16T12:00:00.000Z',
    },
    {
      // §24.177: an owner-minted named source — exposes copy / résumé-PDF / retire.
      code: 'my_linkedin',
      artifactType: 'owner_source',
      company: null,
      recipient: null,
      createdAt: '2026-06-24T10:00:00.000Z',
      expiresAt: null,
      clicks: 5,
      uniqueVisitors: 4,
      lastClickAt: '2026-06-24T12:00:00.000Z',
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
      apply_link_kind: 'ats',
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
      source: 'google_jobs',
      source_url: 'https://x/2',
      apply_url: null,
      apply_link_kind: 'aggregator',
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
      apply_link_kind: null,
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
  // §24.201 slice (b) — the direct-board sweep + the search supplement.
  sourcing: {
    lastSweep: {
      id: 'run-1',
      started_at: '2026-06-25T00:00:00Z',
      finished_at: '2026-06-25T00:01:00Z',
      ok: true,
      trigger: 'schedule',
      boards_ok: 12,
      boards_failed: 1,
      new: 4,
      refreshed: 30,
      closed: 2,
      reopened: 1,
      rejected: { filter: 40, age: 3 },
      failing_boards: [{ company: 'Acme', ats: 'lever', error: 'HTTP 500' }],
    },
    sweepRunning: false,
    lastSearch: {
      at: '2026-06-25T00:00:00Z',
      rejected: { aggregator: 6 },
      rejected_by_site: { 'reposter.example': 6 },
    },
    searchQuota: { used_period: 120, monthly_quota: 250, used_today: 4, daily_cap: 20, period_start: '2026-06-01' },
  },
}

// §24.202 D6 — the employer-board watchlist (contract: AdminWatchlistView).
const WATCHLIST = {
  boards: [
    {
      id: 1,
      ats: 'greenhouse',
      token: 'globex',
      company: 'Globex',
      tier: 'A',
      origin: 'seed',
      state: 'active',
      notes: null,
      last_ok_at: '2026-06-25T00:00:00Z',
      last_error: null,
      consecutive_failures: 0,
      consecutive_absent: 0,
      leads_found: 12,
      last_hit_at: '2026-06-24T00:00:00Z',
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-25T00:00:00Z',
      open_leads: 3,
      board_url: 'https://job-boards.greenhouse.io/globex',
    },
    {
      id: 2,
      ats: 'lever',
      token: 'acme',
      company: 'Acme',
      tier: 'B',
      origin: 'owner',
      state: 'paused',
      notes: null,
      last_ok_at: null,
      last_error: 'HTTP 500',
      consecutive_failures: 2,
      consecutive_absent: 0,
      leads_found: 0,
      last_hit_at: null,
      created_at: '2026-06-10T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
      open_leads: 0,
      board_url: 'https://jobs.lever.co/acme',
    },
  ],
  counts: { total: 2, active: 1, paused: 1, absent: 0, by_origin: { seed: 1, owner: 1 } },
  caps: { max_boards: 200, counted: 2, max_auto_adds_per_run: 5 },
}

// The §24.201 D5 sweep-filter knobs, as GET /api/admin/knobs serves them.
function sweepKnob(key: string, label: string, value: string | number, num?: { min: number; max: number }) {
  return {
    key,
    value,
    default: value,
    overridden: false,
    type: num ? 'number' : 'text',
    group: 'scouting',
    label,
    min: num?.min ?? null,
    max: num?.max ?? null,
    integer: !!num,
    options: null,
    maxLength: num ? null : 1000,
    note: null,
  }
}
const SWEEP_KNOBS = [
  sweepKnob('ats_sweep_title_include', 'Sweep: titles to keep (regex)', '\\bengineer\\b'),
  sweepKnob('ats_sweep_title_exclude', 'Sweep: titles to drop (regex)', '\\bsales\\b'),
  sweepKnob('ats_sweep_location_filter', 'Sweep: locations to keep (regex)', ''),
  sweepKnob('ats_sweep_max_age_days', 'Sweep: max posting age (days)', 30, { min: 1, max: 365 }),
  sweepKnob('ats_sweep_max_new_per_run', 'Sweep: max new leads per run', 40, { min: 0, max: 500 }),
]

const SWEEP_PREVIEW = {
  ok: true,
  total: 40,
  current: { keep: 30, drop: 10, drop_by_reason: { filter: 10 } },
  proposed: { keep: 26, drop: 14, drop_by_reason: { filter: 10, location: 4 } },
  newly_dropped: 4,
  newly_kept: 0,
  sample_newly_dropped: [{ id: 'lead-1', title: 'Senior Software Engineer', company: 'Globex', reason: 'location' }],
  sample_newly_kept: [],
}

// §24.203 — the agent-action switches served with the leads read, and the
// action rows the page polls. Every field matches the contract's row shapes.
const ACTION_META = {
  pause_state: 'active',
  can_enqueue: true,
  daily_cap: 20,
  used_today: 2,
  note_max_chars: 500,
  ttl_minutes: 60,
  guard_minutes: 15,
  compose_authuser: null,
  run_now: {
    job_scrape: { in_flight_action_id: null, next_scheduled_at: '2026-11-16T18:00:00.000Z', guarded: false },
    daily_briefing: { in_flight_action_id: null, next_scheduled_at: '2026-11-17T08:00:00.000Z', guarded: true },
  },
  kit_rounds: ['SCREENING', 'TECH_SCREEN', 'SYS_DESIGN', 'FINAL'],
}

const ACTION_ROW = {
  id: 'act-1',
  kind: 'draft_outreach',
  series: null,
  lead_id: 'lead-1',
  company: 'Globex',
  title: 'Senior Software Engineer',
  application_id: null,
  round: null,
  note: null,
  status: 'queued',
  error: null,
  created_at: '2026-11-16T10:00:00.000Z',
  started_at: null,
  completed_at: null,
  expires_at: '2026-11-16T11:00:00.000Z',
  has_result: false,
}

const ACTION_DONE = {
  ...ACTION_ROW,
  status: 'done',
  started_at: '2026-11-16T10:00:02.000Z',
  completed_at: '2026-11-16T10:01:30.000Z',
  has_result: true,
  result_md: '## Globex\n\nBuilds distributed systems.',
  result_json: {
    subject: 'Senior Software Engineer at Globex',
    body: 'Hi,\n\nI build distributed systems & would love to talk.',
    to: null,
    research_md: '## Globex\n\nBuilds distributed systems.',
  },
  progress: [],
}

/** A finished research result whose lead was deleted — reachable only from the
 *  "Recent agent actions" list. */
const ACTION_ORPHAN = {
  ...ACTION_ROW,
  id: 'act-0',
  kind: 'research_company',
  lead_id: null,
  company: 'Initech',
  title: 'Backend Engineer',
  status: 'done',
  completed_at: '2026-11-15T09:00:00.000Z',
  has_result: true,
}

/** Stub the admin reads (+ the knob/control/sandbox POSTs). `available:false` → every read 404s. */
async function stubAdmin(page: Page, available = true): Promise<void> {
  const read = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill(available ? jsonRoute(body) : jsonRoute({ error: 'not_found' }, 404))

  await page.route('**/api/admin/summary', read(SUMMARY))
  await page.route('**/api/admin/pipeline', read(PIPELINE))
  await page.route('**/api/admin/contacts', read(CONTACTS))
  await page.route('**/api/admin/attribution', async (route) => {
    // §24.177: mint/retire POSTs return ok; the GET serves the read-model.
    if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ ok: true, code: 'x' }, 200))
    return route.fulfill(available ? jsonRoute(ATTRIBUTION) : jsonRoute({ error: 'not_found' }, 404))
  })
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
  await page.route('**/api/admin/watchlist', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ ok: true }, 200))
    return route.fulfill(available ? jsonRoute(WATCHLIST) : jsonRoute({ error: 'not_found' }, 404))
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

    // Visitors tab: the attribution browser + the §24.177 minting surface.
    await page.getByTestId('admin-tab-visitors').click()
    await expect(page.getByText('anthropic.com').first()).toBeVisible()
    await expect(page.getByTestId('visitors-mint-form')).toBeVisible()
    // An owner source exposes its per-source actions; outreach does not.
    await expect(page.getByTestId('visitors-copy-my_linkedin')).toBeVisible()
    await expect(page.getByTestId('visitors-download-my_linkedin')).toHaveAttribute(
      'href',
      /\/api\/admin\/attribution\/my_linkedin\/resume\.pdf$/,
    )

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

  test('the Pipeline tab is read-only and shows attention, days in stage and the row detail (§24.204)', async ({
    page,
  }) => {
    await stubAdmin(page)
    const pipelinePosts: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/pipeline') && req.method() !== 'GET') pipelinePosts.push(req.method())
    })
    await page.goto('/admin')
    await page.getByTestId('admin-tab-pipeline').click()

    const row = page.getByTestId('pipeline-row-app-1')
    await expect(row.getByTestId('pipeline-attention-chip')).toHaveAttribute('data-priority', 'action_owed')
    await expect(row.getByTestId('pipeline-days')).toHaveAttribute('data-ghosting', 'true')
    await expect(row.getByTestId('pipeline-last-email')).toContainText('Thanks for your time')

    await row.click()
    const detail = page.getByTestId('pipeline-detail')
    await expect(detail.getByTestId('pipeline-detail-rationale')).toContainText('Strong platform match')
    await expect(detail.getByTestId('pipeline-detail-timeline')).toContainText('applied → screening')
    await expect(detail.getByTestId('pipeline-link-thread')).toHaveAttribute(
      'href',
      'https://mail.google.com/mail/#all/thr-1',
    )
    await expect(detail.getByTestId('pipeline-resume')).toHaveAttribute('data-sent', 'true')
    await expect(detail.getByRole('button')).toHaveCount(0)

    // The stage chip filters; pressing it again shows every stage.
    await page.getByTestId('pipeline-stage-chip-screening').click()
    await expect(page.getByTestId('pipeline-stage-chip-screening')).toHaveAttribute('aria-pressed', 'true')
    await expect(row).toBeVisible()

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])
    expect(pipelinePosts).toEqual([])
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

  test('Leads triage: link filter, row selection drives the batch, I-applied popover (§24.202)', async ({ page }) => {
    await stubAdmin(page)
    await page.goto('/admin?tab=leads')
    await expect(page.getByTestId('leads-row')).toHaveCount(2)
    await expect(page.getByTestId('leads-link-chip').first()).toHaveText('direct ATS')

    // the Link filter isolates the aggregator repost
    await page.getByTestId('leads-filter-link').selectOption('aggregator')
    await expect(page.getByTestId('leads-row')).toHaveCount(1)
    await expect(page.getByTestId('leads-row')).toContainText('Initech')
    await page.getByTestId('leads-filter-link').selectOption('all')

    // ticking a row narrows the batch to it — and does not expand the row
    await page.getByTestId('leads-row').nth(1).getByTestId('datatable-select-row').check()
    await expect(page.getByTestId('leads-bulk-count')).toHaveText('1')
    await expect(page.getByTestId('leads-bulk-archive')).toHaveText('Archive 1')
    await expect(page.getByTestId('leads-detail')).toHaveCount(0)

    // the detail's "I applied" opens an inline popover with today's date
    await page.getByTestId('leads-row').first().click()
    await page.getByTestId('leads-applied-open').click()
    await expect(page.getByTestId('leads-applied-popover')).toBeVisible()
    await expect(page.getByTestId('leads-applied-date')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('Leads sourcing strip: last sweep, quota, Sweep now, block a board (§24.202 D4/D6)', async ({ page }) => {
    await stubAdmin(page)
    const posted: Record<string, unknown>[] = []
    page.on('request', (req) => {
      if (req.url().endsWith('/api/admin/leads') && req.method() === 'POST') {
        posted.push(req.postDataJSON() as Record<string, unknown>)
      }
    })
    await page.goto('/admin?tab=leads')

    await expect(page.getByTestId('leads-sweep-summary')).toContainText('4 new · 2 closed · 1 reopened')
    await expect(page.getByTestId('leads-search-quota')).toContainText('120 / 250 this period · today 4 / 20')
    await page.getByTestId('leads-sweep-detail-toggle').click()
    await expect(page.getByTestId('leads-sweep-failing-board')).toContainText('Acme (lever)')

    await page.getByTestId('leads-sweep-now').click()
    await expect(page.getByTestId('leads-note')).toContainText('Sweep started')
    await expect.poll(() => posted.some((b) => b.action === 'sweep_now')).toBe(true)

    // a board-sourced lead offers "block this company's board"
    await page.getByTestId('leads-row').first().click()
    await page.getByTestId('leads-ni-open').click()
    await page.getByTestId('leads-ni-block-company').check()
    await page.getByTestId('leads-ni-confirm').click()
    await expect
      .poll(() => posted.find((b) => b.action === 'not_interested'))
      .toMatchObject({ id: 'lead-1', block_company: true })
  })

  test('Watchlist tab + sweep filters + add a lead by link (§24.202 D6/D7)', async ({ page }) => {
    await stubAdmin(page)
    // the knob read now carries the sweep filters (a later route wins)
    await page.route('**/api/admin/knobs', async (route) => {
      if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ applied: true }, 200))
      return route.fulfill(jsonRoute({ knobs: [...KNOBS.knobs, ...SWEEP_KNOBS] }))
    })
    const watchPosts: Record<string, unknown>[] = []
    await page.route('**/api/admin/watchlist', async (route) => {
      if (route.request().method() !== 'POST') return route.fulfill(jsonRoute(WATCHLIST))
      const body = route.request().postDataJSON() as Record<string, unknown>
      watchPosts.push(body)
      if (body.action === 'add_by_url' && String(body.url).includes('example.com')) {
        return route.fulfill(
          jsonRoute(
            {
              error: 'not_board_url',
              message: 'Only Greenhouse, Lever and Ashby links can be added. Other career sites are not fetched.',
            },
            400,
          ),
        )
      }
      if (body.action === 'add_by_url') {
        const board = { ...WATCHLIST.boards[1], id: 3, company: 'Umbrella', token: 'umbrella', state: 'active' }
        return route.fulfill(jsonRoute({ ok: true, board, inserted: true, reactivated: false }))
      }
      if (body.action === 'preview_filters') {
        const f = body.filters as Record<string, unknown>
        if (f.ats_sweep_title_exclude === '(sales') {
          return route.fulfill(
            jsonRoute(
              {
                error: 'invalid_filter',
                field: 'ats_sweep_title_exclude',
                message: 'ats_sweep_title_exclude is not a valid regular expression: Unterminated group',
              },
              400,
            ),
          )
        }
        return route.fulfill(jsonRoute(SWEEP_PREVIEW))
      }
      return route.fulfill(jsonRoute({ ok: true }))
    })
    const knobPosts: unknown[] = []
    page.on('request', (req) => {
      if (req.url().endsWith('/api/admin/knobs') && req.method() === 'POST') knobPosts.push(req.postDataJSON())
    })

    await page.goto('/admin?tab=watchlist')
    await expect(page.getByTestId('watchlist-panel')).toBeVisible()
    await expect(page.getByTestId('watchlist-row')).toHaveCount(2)
    await expect(page.getByTestId('watchlist-counts')).toContainText('2 / 200')

    // pause the active board
    await page.getByTestId('watchlist-row').first().getByTestId('watchlist-pause').click()
    await expect
      .poll(() => watchPosts.find((b) => b.action === 'set_state'))
      .toEqual({ action: 'set_state', id: 1, state: 'paused' })

    // remove is two-step
    await page.getByTestId('watchlist-row').nth(1).getByTestId('watchlist-remove').click()
    expect(watchPosts.some((b) => b.action === 'remove')).toBe(false)
    await page.getByTestId('watchlist-remove-yes').click()
    await expect.poll(() => watchPosts.find((b) => b.action === 'remove')).toEqual({ action: 'remove', id: 2 })

    // a career-site link is refused with the host's sentence
    await page.getByTestId('watchlist-add-url').fill('https://careers.example.com/jobs')
    await page.getByTestId('watchlist-add-submit').click()
    await expect(page.getByTestId('watchlist-add-error')).toContainText('Only Greenhouse, Lever and Ashby links')

    // sweep filters: the preview shows the counts and calls itself an estimate
    await page.getByTestId('sweep-input-ats_sweep_location_filter').fill('remote')
    await page.getByTestId('sweep-preview').click()
    await expect(page.getByTestId('sweep-preview-headline')).toContainText('current filters keep 30, these keep 26')
    await expect(page.getByTestId('sweep-preview-result')).toContainText('An estimate')

    // an uncompilable pattern: the host's message inline, no knob written
    await page.getByTestId('sweep-input-ats_sweep_title_exclude').fill('(sales')
    await page.getByTestId('sweep-save').click()
    await expect(page.getByTestId('sweep-field-error')).toContainText('not a valid regular expression')
    expect(knobPosts).toEqual([])

    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    // Leads tab: add a lead by its posting link, then watch its board
    await page.route('**/api/admin/leads', async (route) => {
      if (route.request().method() !== 'POST') return route.fulfill(jsonRoute(LEADS))
      return route.fulfill(
        jsonRoute({
          ok: true,
          lead_id: 'lead-9',
          outcome: 'created',
          lead_status: 'new',
          tombstone_cleared: false,
          board_proposed: { ats: 'ashby', token: 'umbrella', company: 'Umbrella', already_listed: false, state: null },
        }),
      )
    })
    await page.getByTestId('admin-tab-leads').click()
    await page.getByTestId('leads-add-url-input').fill('https://jobs.ashbyhq.com/umbrella/0b1c2d3e')
    await page.getByTestId('leads-add-url-submit').click()
    await expect(page.getByTestId('leads-add-url-note')).toHaveText('Lead added.')
    await page.getByTestId('leads-add-url-watch').click()
    await expect(page.getByTestId('leads-add-url-watch-note')).toHaveText("Now watching Umbrella's board.")
    expect(watchPosts.at(-1)).toEqual({
      action: 'add_by_url',
      url: 'https://jobs.ashbyhq.com/umbrella/0b1c2d3e',
      company: 'Umbrella',
    })
  })

  test('Leads agent actions: draft outreach → poll → subject, body, compose link; Run now; recent (§24.203)', async ({
    page,
  }) => {
    await stubAdmin(page)
    await page.route('**/api/admin/leads', async (route) => {
      if (route.request().method() === 'POST') return route.fulfill(jsonRoute({ ok: true }, 200))
      return route.fulfill(jsonRoute({ ...LEADS, agentActions: ACTION_META }))
    })
    const actionPosts: Record<string, unknown>[] = []
    await page.route('**/api/admin/actions', async (route) => {
      if (route.request().method() === 'POST') {
        actionPosts.push(route.request().postDataJSON() as Record<string, unknown>)
        return route.fulfill(jsonRoute({ ok: true, action_id: 'act-1', status: 'queued' }, 202))
      }
      return route.fulfill(jsonRoute({ actions: [ACTION_DONE, ACTION_ORPHAN], meta: ACTION_META }))
    })
    // act-1 reads queued once, then done; act-0 is the orphaned research result
    let act1Reads = 0
    await page.route('**/api/admin/actions/*', async (route) => {
      if (route.request().url().endsWith('/act-0')) {
        return route.fulfill(
          jsonRoute({ ...ACTION_ORPHAN, result_md: 'Initech **makes TPS reports**.', result_json: null, progress: [] }),
        )
      }
      act1Reads += 1
      return route.fulfill(
        jsonRoute(act1Reads === 1 ? { ...ACTION_ROW, result_md: null, result_json: null } : ACTION_DONE),
      )
    })

    await page.goto('/admin?tab=leads')
    // Run now sits with the header actions; the briefing is guarded (due soon)
    await expect(page.getByTestId('agent-run-now-job_scrape')).toBeEnabled()
    await expect(page.getByTestId('agent-run-now-daily_briefing')).toBeDisabled()

    await page.getByTestId('leads-row').first().click()
    await page.getByTestId('agent-action-open-draft_outreach').click()
    await expect(page.getByTestId('agent-action-note')).toHaveAttribute(
      'placeholder',
      'Who it is for, or leave blank for a draft with no recipient',
    )
    await page.getByTestId('agent-action-submit').click()
    await expect.poll(() => actionPosts).toEqual([{ action: 'enqueue', kind: 'draft_outreach', lead_id: 'lead-1' }])

    await expect(page.getByTestId('agent-action-status')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('agent-action-outreach-subject')).toHaveText('Senior Software Engineer at Globex')
    await expect(page.getByTestId('agent-action-outreach-body')).toContainText('would love to talk')
    const href = await page.getByTestId('agent-action-compose').getAttribute('href')
    expect(href).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&su=Senior%20Software%20Engineer%20at%20Globex&body=Hi%2C%0A%0AI%20build%20distributed%20systems%20%26%20would%20love%20to%20talk.',
    )
    const a11y = await new AxeBuilder({ page }).analyze()
    expect(a11y.violations).toEqual([])

    // a result whose lead was deleted is still reachable
    await page.getByTestId('agent-actions-recent').locator('summary').click()
    await expect(page.getByTestId('agent-actions-recent-deleted')).toHaveText('lead deleted')
    await page.getByTestId('agent-actions-recent-row').nth(1).getByTestId('agent-actions-recent-show').click()
    await expect(page.getByTestId('agent-actions-recent').getByTestId('agent-action-research')).toContainText(
      'makes TPS reports',
    )
  })

  test('the Watchlist tab is hidden on a host without the watchlist (§24.202 D6)', async ({ page }) => {
    await stubAdmin(page)
    await page.route('**/api/admin/watchlist', (route) => route.fulfill(jsonRoute({ error: 'not_found' }, 404)))
    await page.goto('/admin?tab=leads')
    await expect(page.getByTestId('leads-panel')).toBeVisible()
    await expect(page.getByTestId('admin-tab-system')).toBeVisible()
    await expect(page.getByTestId('admin-tab-watchlist')).toHaveCount(0)
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

  test('the Visitors tab mints a named source — POSTs { mint, slug } (§24.177)', async ({ page }) => {
    await stubAdmin(page)
    await page.goto('/admin?tab=visitors')

    await expect(page.getByTestId('visitors-mint-form')).toBeVisible()
    await page.getByTestId('visitors-mint-slug').fill('conference_talk')

    const reqP = page.waitForRequest((r) => r.url().includes('/api/admin/attribution') && r.method() === 'POST')
    await page.getByTestId('visitors-mint-submit').click()
    expect((await reqP).postDataJSON()).toEqual({ action: 'mint', slug: 'conference_talk' })
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
