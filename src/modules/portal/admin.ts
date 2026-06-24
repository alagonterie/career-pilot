/**
 * src/modules/portal/admin.ts — the owner-only `/admin` surface (STRATEGY §24.74
 * D5 + §17.2). Read-only.
 *
 * Gating (`adminEnabled`): OPEN on the dev stack — the whole dev surface already
 * sits behind owner-only Cloudflare Access, the same trust model the dev
 * inspector relies on. FAIL-CLOSED on any other stack until the owner both wires
 * the prod `/admin*` + `/api/admin/*` Cloudflare Access app (the PRIMARY edge
 * gate) AND flips `admin_api_enabled` (the host kill-switch / defense-in-depth
 * belt). So on prod the surface 404s by default — never exposed to the public
 * site before it's deliberately turned on.
 *
 * Commit 3 ships the attribution browser — the §24.74 deliverable: the minted
 * `/r/<code>` links joined to their `visit_telemetry` clicks (who came from
 * which outbound artifact, from where). The broader §17.2 panels (cost rollups,
 * health, contact submissions) are a follow-up. Nothing here is a writer, and
 * the recruiter-sim / dev knobs are deliberately absent (prod-safe by design).
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { type HealthFinding, runHealthChecks } from '../career-pilot/health.js';
import { type CandidateProfile, readCandidateProfile } from '../career-pilot/render-persona.js';

import { originJwtEnabled } from './access-jwt.js';
import { isDevEnv } from './dev-inspector.js';
import { executeControlCommand, executeKillswitch } from './kill-switch.js';
import { ADMIN_DENY, ADMIN_KNOB_KEYS, KNOB_SPECS, applyKnobWrite, buildKnobs, type KnobView } from './knob-registry.js';
import { computeRunningTopology, getObservability } from './observability.js';
import {
  deleteSimulatorRun,
  getAdminSandboxStats,
  getAdminSimulatorRuns,
  type AdminSimulatorRun,
  type SandboxRunStats,
} from './simulator.js';
import { getSystemStatus, setLiveMode, type SystemStatus } from './system-modes.js';

import { countRunningContainers } from '../../container-runtime.js';

/**
 * True when the owner-only admin surface may serve. Dev → always (owner-gated
 * surface). Otherwise → only when `admin_api_enabled` is set AND origin-JWT
 * validation is active (Access is enforced) — the host belt behind the edge
 * Access app. Never throws.
 */
export function adminEnabled(): boolean {
  if (isDevEnv()) return true;
  try {
    return getConfig<boolean>(getDb(), 'admin_api_enabled', false) && originJwtEnabled();
  } catch {
    return false;
  }
}

export interface AttributionLinkRow {
  code: string;
  artifactType: string;
  company: string | null;
  /** Owner-private (the address we cold-emailed) — only ever served behind the admin gate. */
  recipient: string | null;
  createdAt: string;
  clicks: number;
  uniqueVisitors: number;
  lastClickAt: string | null;
}

export interface AttributionVisit {
  ts: string;
  linkCode: string | null;
  company: string | null;
  country: string | null;
  uaClass: string | null;
  referrer: string | null;
}

export interface AttributionReport {
  links: AttributionLinkRow[];
  recentVisits: AttributionVisit[];
  summary: {
    totalLinks: number;
    totalClicks: number;
    totalUniqueVisitors: number;
    byArtifact: Record<string, number>;
    topCountries: { country: string; clicks: number }[];
  };
}

const EMPTY_REPORT: AttributionReport = {
  links: [],
  recentVisits: [],
  summary: { totalLinks: 0, totalClicks: 0, totalUniqueVisitors: 0, byArtifact: {}, topCountries: [] },
};

/**
 * The attribution browser's read-model: every minted link with its click
 * aggregates, the recent visit feed, and a small summary. Pure read over the two
 * private tables; returns an empty report on an un-migrated DB.
 */
export function buildAttributionReport(db: Database.Database, opts: { recentLimit?: number } = {}): AttributionReport {
  if (!hasTable(db, 'attribution_link') || !hasTable(db, 'visit_telemetry')) return EMPTY_REPORT;

  const links = db
    .prepare(
      `SELECT l.code, l.artifact_type AS artifactType, l.company, l.recipient, l.created_at AS createdAt,
              COUNT(v.id) AS clicks, COUNT(DISTINCT v.ip_hash) AS uniqueVisitors, MAX(v.ts) AS lastClickAt
       FROM attribution_link l
       LEFT JOIN visit_telemetry v ON v.link_code = l.code
       GROUP BY l.code
       ORDER BY clicks DESC, l.created_at DESC`,
    )
    .all() as AttributionLinkRow[];

  const byArtifact: Record<string, number> = {};
  for (const l of links) byArtifact[l.artifactType] = (byArtifact[l.artifactType] ?? 0) + 1;

  const totalClicks = (
    db.prepare('SELECT COUNT(*) AS n FROM visit_telemetry WHERE link_code IS NOT NULL').get() as { n: number }
  ).n;
  const totalUniqueVisitors = (
    db.prepare('SELECT COUNT(DISTINCT ip_hash) AS n FROM visit_telemetry WHERE ip_hash IS NOT NULL').get() as {
      n: number;
    }
  ).n;
  const topCountries = db
    .prepare(
      `SELECT country, COUNT(*) AS clicks FROM visit_telemetry
       WHERE country IS NOT NULL GROUP BY country ORDER BY clicks DESC, country ASC LIMIT 8`,
    )
    .all() as { country: string; clicks: number }[];

  const recentLimit = opts.recentLimit ?? 50;
  const recentVisits = db
    .prepare(
      `SELECT v.ts, v.link_code AS linkCode, l.company, v.country, v.ua_class AS uaClass, v.referrer
       FROM visit_telemetry v
       LEFT JOIN attribution_link l ON l.code = v.link_code
       ORDER BY v.ts DESC LIMIT ?`,
    )
    .all(recentLimit) as AttributionVisit[];

  return {
    links,
    recentVisits,
    summary: { totalLinks: links.length, totalClicks, totalUniqueVisitors, byArtifact, topCountries },
  };
}

// ── §24.138: the control-center knob surface (registry − ADMIN_DENY) ──────────

/** Current value + metadata for every /admin-included knob (registry − ADMIN_DENY). */
export function buildAdminKnobs(db: Database.Database): { knobs: KnobView[] } {
  return { knobs: buildKnobs(db, ADMIN_KNOB_KEYS) };
}

/**
 * Write an /admin knob. The prod surface excludes `ADMIN_DENY` (the recruiter-sim
 * dial incl. its prose model): a denied key that IS a valid registry spec is refused with 403
 * (defense-in-depth behind the not-rendered UI); everything else delegates to the
 * shared `applyKnobWrite`, scoped to `ADMIN_KNOB_KEYS`.
 */
export function applyAdminKnobWrite(db: Database.Database, raw: unknown): { status: number; body: unknown } {
  if (typeof raw === 'object' && raw !== null) {
    const key = (raw as { key?: unknown }).key;
    if (typeof key === 'string' && KNOB_SPECS[key] && ADMIN_DENY.has(key)) {
      return { status: 403, body: { error: `knob not permitted on /admin: ${key}` } };
    }
  }
  return applyKnobWrite(db, raw, ADMIN_KNOB_KEYS);
}

// ── §24.138: the Overview rollup (health · cost · pool · mode) ─────────────────

export interface AdminSummary {
  mode: SystemStatus;
  health: {
    ranAt: string;
    counts: Record<string, number>;
    /** The worst severity present, for the headline dot. */
    worst: string;
    /** Only the non-ok findings (the actionable ones), each with its next_step. */
    findings: HealthFinding[];
  };
  /** 24 h spend per traffic class (microUSD) + sparkline buckets — the §24.69 cost lens. */
  spendByClass: Awaited<ReturnType<typeof getObservability>>['spend_by_class'];
  spendTotalMicrousd24h: number;
  pool: { active: number; capacity: number };
}

const SEVERITY_RANK: Record<string, number> = { ok: 0, warn: 1, critical: 2 };

/** The Overview rollup: live mode + health summary + 24 h cost + container pool. */
export async function buildAdminSummary(db: Database.Database): Promise<AdminSummary> {
  const report = await runHealthChecks({ skipLiveProbes: true });
  const counts: Record<string, number> = {};
  let worst = 'ok';
  for (const f of report.findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    if ((SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) worst = f.severity;
  }
  const findings = report.findings.filter((f) => f.severity !== 'ok');

  const obs = await getObservability();
  const spendTotalMicrousd24h = Object.values(obs.spend_by_class).reduce((sum, s) => sum + s.microusd_24h, 0);

  // The pool gauge counts LIVE CONTAINERS (the same source the /dashboard gauge
  // uses), not active sessions — an active session can exist with no running
  // container (idle/reaped), which is why the old `session_topology` count read
  // wrong here. Prefer the live docker count; fall back to running-session topology
  // (one container per running session) when the runtime is unreachable.
  const live = countRunningContainers();
  const running = computeRunningTopology();
  const activeContainers = live ?? running.chat + running.ops + running.sandbox;

  return {
    mode: getSystemStatus(),
    health: { ranAt: report.ranAt, counts, worst, findings },
    spendByClass: obs.spend_by_class,
    spendTotalMicrousd24h,
    pool: {
      active: activeContainers,
      capacity: getConfig<number>(db, 'container_max_concurrent', 4),
    },
  };
}

// ── §24.138: the Contacts store (§24.121 inbound recruiter submissions) ───────

export interface AdminContact {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  role: string | null;
  source: string | null;
  message: string;
  delivered: number;
  createdAt: string;
}

/** Recent inbound `/contact` submissions (owner-only — emails are owner-private). */
export function buildAdminContacts(db: Database.Database, opts: { limit?: number } = {}): { contacts: AdminContact[] } {
  if (!hasTable(db, 'contact_submissions')) return { contacts: [] };
  const limit = opts.limit ?? 100;
  const contacts = db
    .prepare(
      `SELECT id, name, email, company, role, source, message, delivered, created_at AS createdAt
         FROM contact_submissions ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(limit) as AdminContact[];
  return { contacts };
}

// ── §24.164: the owner-only Sandbox-runs view (inverse of §24.162's public feed) ──

export interface AdminSandboxRunsView {
  runs: AdminSimulatorRun[];
  stats: SandboxRunStats;
}

/** Recent sandbox runs with owner-only detail + the aggregate header. Reachability
 *  is gated upstream (adminEnabled() in the dispatch). */
export function buildAdminSandboxRuns(): AdminSandboxRunsView {
  return { runs: getAdminSimulatorRuns(50), stats: getAdminSandboxStats() };
}

/** Early-delete one sandbox run (purge its stored input before the TTL). */
export function applyAdminSandboxRunDelete(raw: unknown): { status: number; body: unknown } {
  if (typeof raw !== 'object' || raw === null) return { status: 400, body: { error: 'expected a JSON object { id }' } };
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing or non-string "id"' } };
  const deleted = deleteSimulatorRun(id);
  return deleted ? { status: 200, body: { id, deleted: true } } : { status: 404, body: { error: 'not_found', id } };
}

// ── §24.138: the Pipeline summary (owner view — REAL company names) ───────────

interface AdminPipelineRow {
  application_id: string;
  company_name: string | null;
  obfuscated_label: string | null;
  role_title: string | null;
  status: string;
  stage: string;
  applied_at: string | null;
  last_activity_at: string | null;
  win_confidence: number | null;
}

export interface AdminPipeline {
  applications: AdminPipelineRow[];
  stageCounts: Record<string, number>;
}

/**
 * The owner pipeline view: the pipeline read-model joined to `applications` for the
 * REAL company name (the public surface anonymizes; /admin is owner-gated, so it
 * shows the unredacted name). Empty on an un-migrated DB.
 */
export function buildAdminPipeline(db: Database.Database): AdminPipeline {
  if (!hasTable(db, 'public_pipeline_view')) return { applications: [], stageCounts: {} };
  const applications = db
    .prepare(
      `SELECT v.application_id, a.company_name, a.obfuscated_label, v.role_title, v.status, v.stage,
              v.applied_at, v.last_activity_at, v.win_confidence
         FROM public_pipeline_view v
         LEFT JOIN applications a ON a.id = v.application_id
        ORDER BY v.last_activity_at DESC, v.applied_at DESC`,
    )
    .all() as AdminPipelineRow[];

  const stageCounts: Record<string, number> = {};
  for (const r of applications) stageCounts[r.stage] = (stageCounts[r.stage] ?? 0) + 1;
  return { applications, stageCounts };
}

// ── §24.138: the mode controls (pause/resume · kill-switch · live mode) ───────

const DEFAULTS_PATH = path.join(process.cwd(), 'config', 'defaults.json');
/** Fallback if defaults.json is unreadable — the documented live-mode prerequisites. */
const FALLBACK_REQUIRED_FIELDS = ['full_name', 'master_resume', 'target_roles', 'bio', 'search_goals'];

/** The `candidate_profile.*` fields `_required_before_live_mode` names (drift-safe — read from defaults.json). */
function requiredLiveModeFields(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')) as { _required_before_live_mode?: string[] };
    const list = raw._required_before_live_mode;
    if (Array.isArray(list) && list.length > 0) {
      return list.map((k) => k.replace(/^candidate_profile\./, ''));
    }
  } catch {
    /* fall through */
  }
  return FALLBACK_REQUIRED_FIELDS;
}

function fieldPopulated(profile: CandidateProfile, field: string): boolean {
  const v = (profile as unknown as Record<string, unknown>)[field];
  if (field === 'target_roles') {
    if (typeof v !== 'string') return false;
    try {
      const arr = JSON.parse(v) as unknown;
      return Array.isArray(arr) && arr.length > 0;
    } catch {
      return false;
    }
  }
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

/** The required-but-missing profile fields blocking LIVE mode (empty → ready). */
export function liveModeBlockers(profile: CandidateProfile | null): string[] {
  if (!profile) return requiredLiveModeFields();
  return requiredLiveModeFields().filter((f) => !fieldPopulated(profile, f));
}

export interface AdminControlOutcome {
  status: number;
  body: unknown;
}

/**
 * The /admin mode controls. Reversible states run inline; the destructive ones
 * are confirm-gated (400 without `confirm: true`):
 *   { action: 'pause' }                 → /halt (kills containers, freezes spend)
 *   { action: 'resume' }                → /resume (refused while killswitch is set)
 *   { action: 'killswitch', confirm }   → the local hard-stop (manual recovery)
 *   { action: 'set_live_mode', on, confirm? } → flip live_mode; turning ON needs
 *       confirm AND a complete-enough profile (the `_required_before_live_mode` gate).
 */
export async function applyAdminControl(db: Database.Database, raw: unknown): Promise<AdminControlOutcome> {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { action }' } };
  }
  const body = raw as { action?: unknown; confirm?: unknown; on?: unknown };
  const action = body.action;

  if (action === 'pause') {
    const out = executeControlCommand('/halt', 'admin: pause LLM spend', 'admin');
    return { status: 200, body: { pauseState: out.state, killed: out.killed } };
  }

  if (action === 'resume') {
    const out = executeControlCommand('/resume', null, 'admin');
    return { status: 200, body: { pauseState: out.state } };
  }

  if (action === 'killswitch') {
    if (body.confirm !== true) {
      return { status: 400, body: { error: 'killswitch requires { confirm: true }' } };
    }
    const out = await executeKillswitch('admin: kill switch', 'admin');
    return { status: 200, body: { pauseState: out.state, killed: out.killed } };
  }

  if (action === 'set_live_mode') {
    const on = body.on === true || body.on === 'true';
    if (on) {
      if (body.confirm !== true) {
        return { status: 400, body: { error: 'enabling live mode requires { confirm: true }' } };
      }
      const blockers = liveModeBlockers(readCandidateProfile());
      if (blockers.length > 0) {
        return { status: 409, body: { error: 'profile incomplete for live mode', missing: blockers } };
      }
    }
    setLiveMode(on, 'admin');
    return { status: 200, body: { liveMode: on } };
  }

  return { status: 400, body: { error: `unknown action: ${String(action)}` } };
}
