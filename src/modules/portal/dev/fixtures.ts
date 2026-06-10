/**
 * src/modules/portal/dev/fixtures.ts — dev/demo data fixtures + synthetic
 * activity generator for the portal (Sub-milestone 6.3, STRATEGY §24.26).
 *
 * Pure, dependency-light, and **inert in production** — imported only by the
 * dev/test entry scripts (`scripts/portal-dev-server.ts`,
 * `scripts/portal-e2e-server.ts`), never by a request path. Two seed levels:
 *
 *   - seedDeterministicBacklog(db): the small fixed backlog the Playwright E2E
 *     asserts against (moved here verbatim — byte-identical, stable snapshots).
 *   - seedRichFixture(db): the fat dev seed — applications across the funnel,
 *     a deep audit backlog, simulator runs, and active sessions — so every
 *     dynamic page (/live, /funnel, /architecture, /) renders populated.
 *
 * The synthetic generator (buildSyntheticEvent / insertSyntheticEvent) inserts
 * one plausible `public_audit_trail` row at a time; the SSE tail (poll by seq,
 * §24.16) delivers it live with no push wiring. mockContainerCount feeds the
 * `PORTAL_MOCK_CONTAINERS` dev seam that fakes `docker ps` in prod. (The
 * telemetry panels read the seeded turn rows directly — §24.47 — no Portkey seam.)
 *
 * This module is written to be reusable by a future *disclosed* deployed
 * "demo mode" (Phase 9/10) behind a system-mode + on-page banner.
 */
import type Database from 'better-sqlite3';

import { upsertPublicFunnelView } from '../public-funnel-view.js';

// ── low-level helpers ──────────────────────────────────────────────────────

export interface AuditSeed {
  seq: number;
  ts: string;
  category: string;
  agent_name?: string | null;
  proactive?: 0 | 1;
  application_ref?: string | null;
  model_used?: string | null;
  tokens?: number | null;
  cost_cents?: number | null;
  cache_hit?: 0 | 1;
  /** Quantitative cache lane (§24.55) — share of prompt tokens served from cache, 0–100. */
  cache_read_pct?: number | null;
  latency_ms?: number | null;
  /** Per-turn details (duration_api_ms + model_usage) — drives the §24.47 telemetry lanes. */
  details_json?: string | null;
  summary: string;
}

export function insertAuditRow(db: Database.Database, row: AuditSeed): void {
  db.prepare(
    `INSERT INTO public_audit_trail
       (id, seq, ts, category, agent_name, proactive, application_ref,
        model_used, tokens, cost_cents, cache_hit, cache_read_pct, latency_ms, details_json, summary)
     VALUES (@id, @seq, @ts, @category, @agent_name, @proactive, @application_ref,
        @model_used, @tokens, @cost_cents, @cache_hit, @cache_read_pct, @latency_ms, @details_json, @summary)`,
  ).run({
    id: `dev-${row.seq}`,
    seq: row.seq,
    ts: row.ts,
    category: row.category,
    agent_name: row.agent_name ?? null,
    proactive: row.proactive ?? 0,
    application_ref: row.application_ref ?? null,
    model_used: row.model_used ?? null,
    tokens: row.tokens ?? null,
    cost_cents: row.cost_cents ?? null,
    cache_hit: row.cache_hit ?? 0,
    cache_read_pct: row.cache_read_pct ?? null,
    latency_ms: row.latency_ms ?? null,
    details_json: row.details_json ?? null,
    summary: row.summary,
  });
}

export function seedMode(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO system_modes (key, value, changed_at) VALUES (?, ?, ?)`).run(
    key,
    value,
    '2026-06-02T00:00:00Z',
  );
}

export function nextAuditSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM public_audit_trail').get() as { s: number };
  return row.s;
}

// ── deterministic backlog (E2E — keep byte-identical) ──────────────────────

/**
 * The fixed 3-row backlog the Playwright E2E asserts against (smoke + visual).
 * Moved verbatim from scripts/portal-e2e-server.ts; do NOT change the rows,
 * timestamps, or seqs without re-blessing the visual baselines.
 */
export function seedDeterministicBacklog(db: Database.Database): void {
  seedMode(db, 'live_mode', 'true');
  seedMode(db, 'pause_state', 'active');

  insertAuditRow(db, {
    seq: 1,
    ts: '2026-06-02T16:30:00Z',
    category: 'funnel',
    proactive: 1,
    application_ref: 'fintech-a',
    summary: 'advanced to tech screen',
  });
  insertAuditRow(db, {
    seq: 2,
    ts: '2026-06-02T16:35:00Z',
    category: 'subagent_progress',
    agent_name: 'research-company',
    proactive: 1,
    summary: 'mapped the engineering org',
  });
  insertAuditRow(db, {
    seq: 3,
    ts: '2026-06-02T16:42:00Z',
    category: 'funnel',
    proactive: 0,
    application_ref: 'ai-infra-b',
    summary: 'logged a recruiter reply',
  });
  // A per-turn telemetry row (§24.34). The LLM economics live HERE — on a
  // category='turn' summary row — never on the funnel/progress rows above
  // (those carry no per-event cost; the SDK resolves cost only per turn).
  // This is the seeded row the ticker + /live LogStream light their
  // model/tokens/cost/cache/latency lanes from.
  insertAuditRow(db, {
    seq: 4,
    ts: '2026-06-02T16:45:00Z',
    category: 'turn',
    proactive: 1,
    model_used: 'opus-4-8',
    tokens: 18400,
    cost_cents: 6,
    cache_hit: 1,
    cache_read_pct: 90,
    latency_ms: 2100,
    // details_json drives the §24.47 telemetry lanes (cache rate, turn p50, top
    // model) — fixed values so the /live visual baseline stays deterministic:
    // cache_read 900 / (input 100 + read 900) = 90%; p50 = duration 2100ms.
    details_json: JSON.stringify({
      num_turns: 1,
      duration_api_ms: 2100,
      total_cost_usd: 0.06,
      model_usage: { 'opus-4-8': { input: 100, output: 200, cache_read: 900, cache_creation: 0, cost_usd: 0.06 } },
    }),
    summary: 'turn complete',
  });
}

// ── deterministic funnel seed (E2E /funnel — fixed rows, stable board) ──────

interface DetFunnelSeed {
  company: string;
  label: string;
  role: string;
  status: string;
  publicState: 'obfuscated' | 'public';
  win: number;
  appliedAt: string;
  lastActivityAt: string;
}

// Fixed applications spanning the displayed pipeline columns (one public
// OFFER). Self-contained like seedDeterministicBacklog — no system_modes write
// (the audit seed owns those). Timestamps are fixed; the day-counts the API
// derives from them drift with wall-clock, so the /funnel visual baseline masks
// those numeric regions (the semantic E2E asserts the stage/label/name, which
// are time-independent). Do NOT change these without re-blessing funnel.png.
const DET_FUNNEL_SEEDS: DetFunnelSeed[] = [
  {
    company: 'Acme Corp',
    label: 'fintech-a',
    // Deliberately long + real-shaped (§24.58): one seeded title MUST exceed a
    // phone viewport's width as nowrap min-content, so the mobile overflow
    // guard exercises the grid min-width clamp (short titles kept CI green
    // while real box data overflowed).
    role: 'Senior Software Engineer, Distributed Systems (Remote-friendly but US only)',
    status: 'APPLIED',
    publicState: 'obfuscated',
    win: 40,
    appliedAt: '2026-05-12T09:00:00Z',
    lastActivityAt: '2026-05-14T09:00:00Z',
  },
  {
    company: 'Globex',
    label: 'fintech-b',
    role: 'Staff Engineer',
    status: 'SCREENING',
    publicState: 'obfuscated',
    win: 55,
    appliedAt: '2026-05-08T09:00:00Z',
    lastActivityAt: '2026-05-20T09:00:00Z',
  },
  {
    company: 'Initech',
    label: 'ai-infra-a',
    role: 'Senior AI Specialist',
    status: 'TECH_SCREEN',
    publicState: 'obfuscated',
    win: 62,
    appliedAt: '2026-05-05T09:00:00Z',
    lastActivityAt: '2026-05-22T09:00:00Z',
  },
  {
    company: 'Stark Industries',
    label: 'devtools-a',
    role: 'Staff DevX Engineer',
    status: 'FINAL',
    publicState: 'obfuscated',
    win: 73,
    appliedAt: '2026-05-01T09:00:00Z',
    lastActivityAt: '2026-05-24T09:00:00Z',
  },
  {
    company: 'Wayne Enterprises',
    label: 'devtools-b',
    role: 'Principal Engineer',
    status: 'OFFER',
    publicState: 'public',
    win: 84,
    appliedAt: '2026-04-26T09:00:00Z',
    lastActivityAt: '2026-05-25T09:00:00Z',
  },
];

/**
 * Seed a fixed set of applications + their public_funnel_view rows for the
 * Playwright /funnel E2E. Built through the real `upsertPublicFunnelView`
 * projection (FK-safe, valid stages). Additive — the existing smoke/work specs
 * don't read /api/funnel, so they're unaffected.
 */
export function seedDeterministicFunnel(db: Database.Database): void {
  const insertApp = db.prepare(
    `INSERT INTO applications
       (id, company_name, obfuscated_label, public_state, role_title, status,
        win_confidence, applied_at, last_activity_at, created_at)
     VALUES (@id, @company, @label, @public_state, @role, @status,
        @win, @applied_at, @last_activity_at, @created_at)`,
  );
  for (let i = 0; i < DET_FUNNEL_SEEDS.length; i++) {
    const a = DET_FUNNEL_SEEDS[i];
    const id = `det-app-${i + 1}`;
    insertApp.run({
      id,
      company: a.company,
      label: a.label,
      public_state: a.publicState,
      role: a.role,
      status: a.status,
      win: a.win,
      applied_at: a.appliedAt,
      last_activity_at: a.lastActivityAt,
      created_at: a.appliedAt,
    });
    upsertPublicFunnelView(db, id);
  }
}

// ── deterministic simulator run (E2E share page — fixed row) ────────────────

/**
 * Seed one fixed, shareable, non-expiring `simulator_runs` row so the read-only
 * `/simulator/results/$id` share page (Sub-milestone 8.2, §24.31) renders
 * deterministically. `expires_at` is far-future so `getSimulatorResult` always
 * returns it; content is fixed. Do NOT change without re-blessing simulator-results.png.
 */
export function seedDeterministicSimulatorRun(db: Database.Database): void {
  db.prepare(
    `INSERT INTO simulator_runs
       (id, ts, visitor_company, visitor_role, jd_excerpt, tailored_resume,
        outreach_draft, total_cost_cents, total_latency_ms, cache_hit_count, shareable, expires_at, trace_json)
     VALUES (@id, @ts, @company, @role, @jd, @resume, @outreach, @cost, @latency, @cache, 1, @expires, @trace)`,
  ).run({
    id: 'det-sim-1',
    ts: '2026-06-01T12:00:00Z',
    company: 'Wayne Enterprises',
    role: 'Principal Engineer',
    jd: 'We need a principal engineer to lead our platform org.',
    resume: [
      '## Tailored resume — Principal Engineer @ Wayne Enterprises',
      '',
      '- Shipped a multi-region ingestion pipeline on GCP serving 4B+ events/day.',
      '- Cut p99 API latency 38% via edge caching + read-model projections.',
      '- Led a 4-engineer team through a zero-downtime datastore migration.',
      '',
      '## Cold outreach — Wayne Enterprises',
      '',
      'Subject: Principal Engineer — a builder who ships at your scale',
      '',
      'Hi there, I came across your recent engineering work and would love a short conversation.',
    ].join('\n'),
    outreach: null,
    cost: 4,
    latency: 22000,
    cache: 1,
    expires: '2099-01-01T00:00:00Z',
    // Mirrors the live wire shape — the share page's expandable activity
    // section (§24.31 Δ) renders from this.
    trace: JSON.stringify([
      { t: 'tool', name: 'analyze_jd', input_summary: '{"role":"Principal Engineer"}', parent_tool_use_id: null },
      {
        t: 'subagent',
        subagent: 'research-company',
        input_summary: '{"description":"Research Wayne Enterprises engineering signal"}',
        parent_tool_use_id: null,
      },
      {
        t: 'tool',
        name: 'WebSearch',
        input_summary: '{"query":"Wayne Enterprises engineering"}',
        parent_tool_use_id: 'toolu_research',
      },
      {
        t: 'subagent',
        subagent: 'tailor-resume',
        input_summary: '{"description":"Rank + rewrite top bullets"}',
        parent_tool_use_id: null,
      },
      {
        t: 'subagent',
        subagent: 'draft-outreach',
        input_summary: '{"description":"Tone-matched cold email"}',
        parent_tool_use_id: null,
      },
    ]),
  });
}

// ── rich dev seed ───────────────────────────────────────────────────────────

interface AppSeed {
  company: string;
  label: string;
  role: string;
  status: string;
  publicState: 'obfuscated' | 'public';
  win: number;
  appliedDaysAgo: number;
}

// Generic personas/companies — no real personal data (see project-generic-persona).
const APP_SEEDS: AppSeed[] = [
  {
    company: 'Acme Corp',
    label: 'fintech-a',
    role: 'Senior Software Engineer',
    status: 'APPLIED',
    publicState: 'obfuscated',
    win: 45,
    appliedDaysAgo: 18,
  },
  {
    company: 'Globex',
    label: 'fintech-b',
    role: 'Staff Engineer',
    status: 'SCREENING',
    publicState: 'obfuscated',
    win: 52,
    appliedDaysAgo: 14,
  },
  {
    company: 'Initech',
    label: 'ai-infra-a',
    role: 'Senior AI Specialist',
    status: 'TECH_SCREEN',
    publicState: 'obfuscated',
    win: 61,
    appliedDaysAgo: 11,
  },
  {
    company: 'Umbrella',
    label: 'ai-infra-b',
    role: 'Lead Software Engineer',
    status: 'SYS_DESIGN',
    publicState: 'obfuscated',
    win: 64,
    appliedDaysAgo: 9,
  },
  {
    company: 'Stark Industries',
    label: 'devtools-a',
    role: 'Staff DevX Engineer',
    status: 'FINAL',
    publicState: 'obfuscated',
    win: 72,
    appliedDaysAgo: 6,
  },
  {
    company: 'Wayne Enterprises',
    label: 'devtools-b',
    role: 'Principal Engineer',
    status: 'OFFER',
    publicState: 'public',
    win: 81,
    appliedDaysAgo: 4,
  },
  {
    company: 'Soylent',
    label: 'saas-a',
    role: 'Senior Software Engineer',
    status: 'BOOKMARKED',
    publicState: 'obfuscated',
    win: 30,
    appliedDaysAgo: 2,
  },
  {
    company: 'Hooli',
    label: 'saas-b',
    role: 'Backend Engineer',
    status: 'REJECTED',
    publicState: 'obfuscated',
    win: 18,
    appliedDaysAgo: 22,
  },
];

const DAY_MS = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function seedApplicationsAndFunnel(db: Database.Database): void {
  const insertApp = db.prepare(
    `INSERT INTO applications
       (id, company_name, obfuscated_label, public_state, role_title, status,
        win_confidence, applied_at, last_activity_at, created_at)
     VALUES (@id, @company, @label, @public_state, @role, @status,
        @win, @applied_at, @last_activity_at, @created_at)`,
  );
  for (let i = 0; i < APP_SEEDS.length; i++) {
    const a = APP_SEEDS[i];
    const id = `dev-app-${i + 1}`;
    const appliedAt = isoDaysAgo(a.appliedDaysAgo);
    const lastActivity = isoDaysAgo(Math.max(0, a.appliedDaysAgo - 3));
    insertApp.run({
      id,
      company: a.company,
      label: a.label,
      public_state: a.publicState,
      role: a.role,
      status: a.status,
      win: a.win,
      applied_at: appliedAt,
      last_activity_at: lastActivity,
      created_at: appliedAt,
    });
    // Build the public read-model row through the real projection (FK-safe,
    // exercises the production write path, guarantees a valid stage).
    upsertPublicFunnelView(db, id);
  }
}

// Current subagent ids + one deliberate legacy id: real audit history contains
// 'funnel-curator' rows from before the §24.59 rename, and the frontend
// display-aliases them — seeding one keeps that alias path exercised in e2e.
const AGENTS = [
  'research-company',
  'tailor-resume',
  'draft-outreach',
  'build-interview-kit',
  'scrape-jobs',
  'pipeline-scribe',
  'funnel-curator',
];
const MODELS = ['opus-4-8', 'sonnet-4-6', 'haiku-4-5'];

function seedAuditBacklog(db: Database.Database): void {
  const labels = APP_SEEDS.map((a) => a.label);
  const total = 42;
  for (let i = 0; i < total; i++) {
    const seq = i + 1;
    // Spread over the last ~6 hours, oldest first (ascending seq).
    const ts = new Date(Date.now() - (total - i) * 8 * 60_000).toISOString();

    // Every 5th row is a per-turn telemetry row (§24.34) — the LLM economics
    // live ONLY on category='turn' rows (the SDK resolves cost per turn, not
    // per event). Funnel/progress rows leave the telemetry lanes NULL: that is
    // the real shape, so the seeded demo never misrepresents it.
    if (i % 5 === 0) {
      insertAuditRow(db, {
        seq,
        ts,
        category: 'turn',
        proactive: i % 4 === 0 ? 0 : 1,
        model_used: MODELS[i % MODELS.length],
        tokens: 8000 + ((i * 137) % 30000),
        cost_cents: 3 + (i % 12),
        cache_hit: i % 2 === 0 ? 1 : 0,
        cache_read_pct: 55 + ((i * 7) % 41),
        latency_ms: 1200 + ((i * 53) % 4000),
        summary: 'turn complete',
      });
      continue;
    }

    const isSubagent = i % 3 !== 0;
    insertAuditRow(db, {
      seq,
      ts,
      category: isSubagent ? 'subagent_progress' : 'funnel',
      agent_name: isSubagent ? AGENTS[i % AGENTS.length] : null,
      proactive: i % 4 === 0 ? 0 : 1,
      application_ref: labels[i % labels.length],
      summary: SUMMARY_POOL[i % SUMMARY_POOL.length],
    });
  }
}

const SUMMARY_POOL = [
  'mapped the engineering org',
  'tailored the resume to the JD',
  'drafted a follow-up to the recruiter',
  'advanced to tech screen',
  'logged a recruiter reply',
  'pulled fresh roles from the board',
  'flagged an upcoming onsite',
  'summarized the take-home prompt',
  'noted a comp data point',
  'scheduled a prep block',
];

function seedSimulatorRuns(db: Database.Database): void {
  const insertRun = db.prepare(
    `INSERT INTO simulator_runs
       (id, ts, visitor_company, visitor_role, jd_excerpt, tailored_resume,
        total_cost_cents, total_latency_ms, cache_hit_count, shareable, expires_at)
     VALUES (@id, @ts, @company, @role, @jd, @resume, @cost, @latency, @cache, 1, @expires)`,
  );
  const runs = [
    { company: 'Northwind', role: 'Senior Backend Engineer' },
    { company: 'Contoso', role: 'AI Platform Engineer' },
    { company: 'Fabrikam', role: 'Staff DevX Engineer' },
  ];
  for (let i = 0; i < runs.length; i++) {
    insertRun.run({
      id: `dev-sim-${i + 1}`,
      ts: isoDaysAgo(i + 1),
      company: runs[i].company,
      role: runs[i].role,
      jd: 'We are looking for a senior engineer to…',
      resume: '## Tailored resume\n- Did the thing\n- Shipped the other thing',
      cost: 30 + i * 7,
      latency: 8000 + i * 1500,
      cache: 3 + i,
      expires: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
  }
}

export function seedSessions(db: Database.Database): void {
  // /api/architecture reads sessions: active = status 'active'; running =
  // container_status IN ('running','idle'). Seed a parent agent group (FK), then
  // a couple of live sessions. Exported for the E2E server (§24.28): the
  // architecture page needs deterministic non-zero session counts so its node
  // badges render "active" rather than "idle" in the visual baseline.
  db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`).run(
    'dev-ag-career-pilot',
    'career-pilot',
    'career-pilot',
    isoDaysAgo(30),
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, agent_group_id, status, container_status, last_active, created_at)
     VALUES (@id, 'dev-ag-career-pilot', 'active', @container_status, @last_active, @created_at)`,
  );
  insertSession.run({
    id: 'dev-sess-1',
    container_status: 'running',
    last_active: isoDaysAgo(0),
    created_at: isoDaysAgo(0),
  });
  insertSession.run({
    id: 'dev-sess-2',
    container_status: 'idle',
    last_active: isoDaysAgo(0),
    created_at: isoDaysAgo(0),
  });
}

/** The fat dev seed — every dynamic surface populated. */
export function seedRichFixture(db: Database.Database): void {
  seedMode(db, 'live_mode', 'true');
  seedMode(db, 'pause_state', 'active');
  seedApplicationsAndFunnel(db);
  seedAuditBacklog(db);
  seedSimulatorRuns(db);
  seedSessions(db);
}

// ── synthetic activity generator ────────────────────────────────────────────

export interface GeneratorState {
  tick: number;
  labels: string[];
}

export function newGeneratorState(): GeneratorState {
  return { tick: 0, labels: APP_SEEDS.map((a) => a.label) };
}

/**
 * Pure: pick one plausible event for the current tick (no seq/ts — those are
 * assigned at insert). Rotates through a template pool so the stream is
 * reproducible but lively.
 */
export function buildSyntheticEvent(state: GeneratorState): Omit<AuditSeed, 'seq' | 'ts'> {
  const t = state.tick;
  // Every 5th tick emits a per-turn telemetry row (§24.34) carrying the LLM
  // lanes; all other ticks are funnel/progress rows with the lanes NULL — the
  // real shape (cost is a per-turn fact, never a per-event one).
  if (t % 5 === 0) {
    return {
      category: 'turn',
      agent_name: null,
      proactive: t % 4 === 0 ? 0 : 1,
      application_ref: null,
      model_used: MODELS[t % MODELS.length],
      tokens: 9000 + ((t * 211) % 28000),
      cost_cents: 3 + (t % 10),
      cache_hit: t % 2 === 0 ? 1 : 0,
      cache_read_pct: 55 + ((t * 11) % 41),
      latency_ms: 1300 + ((t * 67) % 3800),
      summary: 'turn complete',
    };
  }
  const isSubagent = t % 3 !== 0;
  return {
    category: isSubagent ? 'subagent_progress' : 'funnel',
    agent_name: isSubagent ? AGENTS[t % AGENTS.length] : null,
    proactive: t % 4 === 0 ? 0 : 1,
    application_ref: state.labels[t % state.labels.length],
    summary: SUMMARY_POOL[t % SUMMARY_POOL.length],
  };
}

/** Insert one synthetic event (seq = MAX+1, ts = now). Returns the new seq. */
export function insertSyntheticEvent(db: Database.Database, state: GeneratorState): number {
  const seq = nextAuditSeq(db);
  insertAuditRow(db, { ...buildSyntheticEvent(state), seq, ts: new Date().toISOString() });
  state.tick += 1;
  return seq;
}

const STATUS_PROGRESSION: Record<string, string> = {
  APPLIED: 'SCREENING',
  SCREENING: 'TECH_SCREEN',
  TECH_SCREEN: 'FINAL',
  SYS_DESIGN: 'FINAL',
  FINAL: 'OFFER',
};

/**
 * Every 5th tick, advance the stalest in-flight application one stage and
 * re-project its public_funnel_view row — so the funnel board visibly moves
 * during a dev session. No-op on other ticks / when nothing is advanceable.
 */
export function maybeAdvanceFunnel(db: Database.Database, state: GeneratorState): void {
  if (state.tick % 5 !== 0) return;
  const app = db
    .prepare(
      `SELECT id, status FROM applications
        WHERE status IN ('APPLIED','SCREENING','TECH_SCREEN','SYS_DESIGN','FINAL')
        ORDER BY last_activity_at ASC LIMIT 1`,
    )
    .get() as { id: string; status: string } | undefined;
  if (!app) return;
  const next = STATUS_PROGRESSION[app.status];
  if (!next) return;
  db.prepare(`UPDATE applications SET status = ?, last_activity_at = ? WHERE id = ?`).run(
    next,
    new Date().toISOString(),
    app.id,
  );
  upsertPublicFunnelView(db, app.id);
}

// ── mock payloads for the env-gated dev seams ───────────────────────────────

/** Fake running-container count for PORTAL_MOCK_CONTAINERS. */
export function mockContainerCount(): number {
  return 2;
}
