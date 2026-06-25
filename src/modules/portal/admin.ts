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
import { log } from '../../log.js';
import { PROFILE_FIELDS, normalizeProfileValue } from '../career-pilot/actions.js';
import { type HealthFinding, runHealthChecks } from '../career-pilot/health.js';
import { VALID_STATUSES } from '../career-pilot/job-lead-actions.js';
import {
  computeRulesScore,
  profileFromRow,
  type CandidateProfileForScoring,
} from '../career-pilot/lead-rules-score.js';
import { type CandidateProfile, readCandidateProfile, renderPersona } from '../career-pilot/render-persona.js';
import type { JobLeadPayload } from '../career-pilot/scrape-jobs/types.js';

import { originJwtEnabled } from './access-jwt.js';
import { isDevEnv } from './dev-inspector.js';
import { executeControlCommand, executeKillswitch } from './kill-switch.js';
import { ADMIN_DENY, ADMIN_KNOB_KEYS, KNOB_SPECS, applyKnobWrite, buildKnobs, type KnobView } from './knob-registry.js';
import { computeRunningTopology, getObservability } from './observability.js';
import { projectWorkProfile } from './profile.js';
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

// ── §24.170: the Persona tab (owner-only candidate-profile editor) ─────────────
//
// candidate_profile fans out to the live agent (renderPersona host-fragment), the
// public /api/profile identity, and the sanitizer's name redaction. This is the
// prod-available view+edit surface — the dev-inspector is a dev-only destructive
// re-onboarding harness. Owner-only behind the Access gate, like all of /admin.

/** The candidate_profile columns the Persona tab shows: the agent's onboarding
 * PROFILE_FIELDS + protected_terms (the redaction keep-list, not an onboarding
 * step). work_profile_json is edited via its own validated path, below. */
const PERSONA_DISPLAY_FIELDS = new Set<string>([...PROFILE_FIELDS, 'protected_terms']);

/** Shown but NOT writable here: gmail_account is OAuth/OneCLI-managed — editing
 * the address alone would desync it from the vault token. */
const PERSONA_READONLY_FIELDS = new Set<string>(['gmail_account']);

/** candidate_profile columns present at read but not on the CandidateProfile type. */
interface PersonaRow extends CandidateProfile {
  public_email: string | null;
  work_profile_source: string | null;
  work_profile_generated_at: string | null;
}

export interface AdminPersona {
  /** Editable scalar/array fields, raw stored values (the client parses arrays). */
  fields: Record<string, unknown>;
  /** Fields shown read-only (e.g. gmail_account). */
  readonlyFields: string[];
  /** The work-profile + its HONEST provenance (source / generated_at). */
  workProfile: { json: string | null; source: string | null; generated_at: string | null };
  /** The markdown the agent will receive on its next session (renderPersona). */
  personaPreview: string;
  /** Required-but-missing fields blocking LIVE mode (empty → ready). */
  blockers: string[];
}

/** The Persona tab read: editable fields + work-profile provenance + a live
 * persona preview + the go-live readiness blockers. */
export function buildAdminPersona(db: Database.Database): AdminPersona {
  const profile = (db.prepare('SELECT * FROM candidate_profile WHERE id = 1').get() as PersonaRow | undefined) ?? null;
  const row = profile as unknown as Record<string, unknown> | null;
  const fields: Record<string, unknown> = {};
  for (const f of PERSONA_DISPLAY_FIELDS) fields[f] = row ? (row[f] ?? null) : null;
  return {
    fields,
    readonlyFields: [...PERSONA_READONLY_FIELDS],
    workProfile: {
      json: profile?.work_profile_json ?? null,
      source: profile?.work_profile_source ?? null,
      generated_at: profile?.work_profile_generated_at ?? null,
    },
    personaPreview: renderPersona(profile),
    blockers: liveModeBlockers(profile),
  };
}

/**
 * The Persona tab write: one { field, value } at a time.
 *   - work_profile_json → validated through the SAME `projectWorkProfile` the
 *     agent uses; stored `source='manual'` (§24.170 D2 — never 'agent', so the
 *     /work AI-provenance mark stays honest).
 *   - any other display field (minus the read-only ones) → normalized via the
 *     onboarding `normalizeProfileValue` and written. The field is allow-listed,
 *     so the column interpolation is injection-safe.
 */
export function applyAdminPersonaWrite(db: Database.Database, raw: unknown): { status: number; body: unknown } {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { field, value }' } };
  }
  const { field, value } = raw as { field?: unknown; value?: unknown };
  if (typeof field !== 'string') {
    return { status: 400, body: { error: 'field (string) is required' } };
  }
  const now = new Date().toISOString();
  // Ensure the single row exists (mirrors onboarding / set_work_profile).
  db.prepare(`INSERT INTO candidate_profile (id, updated_at) VALUES (1, @now) ON CONFLICT(id) DO NOTHING`).run({ now });

  if (field === 'work_profile_json') {
    const rawWp = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    const projected = projectWorkProfile(rawWp);
    if (!projected) {
      return { status: 400, body: { error: 'work_profile must be a WorkProfile object with a non-empty name' } };
    }
    db.prepare(
      `UPDATE candidate_profile
          SET work_profile_json = @json, work_profile_source = 'manual',
              work_profile_generated_at = @now, updated_at = @now
        WHERE id = 1`,
    ).run({ json: JSON.stringify(projected), now });
    return { status: 200, body: { ok: true, field, source: 'manual', generated_at: now } };
  }

  if (!PERSONA_DISPLAY_FIELDS.has(field) || PERSONA_READONLY_FIELDS.has(field)) {
    return { status: 400, body: { error: `field not editable on /admin: ${field}` } };
  }
  const normalized = normalizeProfileValue(field, value);
  db.prepare(`UPDATE candidate_profile SET ${field} = @v, updated_at = @now WHERE id = 1`).run({ v: normalized, now });
  return { status: 200, body: { ok: true, field, value: normalized } };
}

// ── §24.173: the Leads tab (the job_leads world-model — inspect + triage) ──────
//
// job_leads is the orchestrator's continuously-maintained pool of discovered
// roles (scrape-jobs writes it; the killer-match + close-detection sweeps tend
// it). This is the owner-only view+triage surface — REAL company names, behind
// the Access gate like all of /admin. Reads are the pool rollup + the leads;
// writes are a small, safe set (status / archive / re-score), never content
// edits (source-of-record from the board) or manual creation (scrape-jobs' job).

/** A lead row as served to /admin (real company; rules_score_reasons parsed). The
 * full JD is NOT shipped — only a short snippet; source_url has the original. */
export interface AdminLead {
  id: string;
  source: string;
  source_url: string;
  apply_url: string | null;
  title: string;
  company: string;
  company_domain: string | null;
  location_raw: string | null;
  is_remote: number | null;
  workplace_type: string | null;
  comp_min_usd: number | null;
  comp_max_usd: number | null;
  comp_currency: string | null;
  comp_period: string | null;
  rules_score: number | null;
  rules_score_reasons: unknown;
  llm_score: number | null;
  llm_scored_at: string | null;
  status: string;
  status_changed_at: string;
  first_seen_at: string;
  last_seen_at: string;
  source_posted_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  killer_match_pushed_at: string | null;
  application_id: string | null;
  snippet: string | null;
}

export interface AdminLeadsRollup {
  activeTotal: number;
  closedTotal: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  llmScored: number;
  pushed24h: number;
  added24h: number;
  added7d: number;
  newestAgeHours: number | null;
}

export interface AdminLeadsView {
  rollup: AdminLeadsRollup;
  /** Active leads (closed_at IS NULL), rules_score DESC, capped. */
  leads: AdminLead[];
  /** Recently-closed leads, closed_at DESC, capped — the client toggles these in. */
  closed: AdminLead[];
}

// The owner can set every lifecycle status EXCEPT 'applied' — that one implies a
// promotion + an application_id link the agent owns; setting it by hand would
// leave an inconsistent (applied-but-unlinked) lead.
const OWNER_SETTABLE_LEAD_STATUSES = new Set([...VALID_STATUSES].filter((s) => s !== 'applied'));

const ADMIN_LEAD_COLS = `id, source, source_url, apply_url, title, company, company_domain,
  location_raw, is_remote, workplace_type, comp_min_usd, comp_max_usd, comp_currency, comp_period,
  rules_score, rules_score_reasons, llm_score, llm_scored_at,
  status, status_changed_at, first_seen_at, last_seen_at, source_posted_at,
  closed_at, closed_reason, killer_match_pushed_at, application_id,
  substr(description_text, 1, 200) AS snippet`;

const ADMIN_LEADS_ACTIVE_CAP = 300;
const ADMIN_LEADS_CLOSED_CAP = 120;

function parseLeadReasons(rows: AdminLead[]): AdminLead[] {
  for (const r of rows) {
    if (typeof r.rules_score_reasons === 'string') {
      try {
        r.rules_score_reasons = JSON.parse(r.rules_score_reasons);
      } catch {
        /* leave as string */
      }
    }
  }
  return rows;
}

/** The Leads tab read: the pool rollup + the active leads + the recently-closed
 * set (the client toggles closed in). Empty on an un-migrated DB. */
export function buildAdminLeads(db: Database.Database): AdminLeadsView {
  const empty: AdminLeadsView = {
    rollup: {
      activeTotal: 0,
      closedTotal: 0,
      byStatus: {},
      bySource: {},
      llmScored: 0,
      pushed24h: 0,
      added24h: 0,
      added7d: 0,
      newestAgeHours: null,
    },
    leads: [],
    closed: [],
  };
  if (!hasTable(db, 'job_leads')) return empty;

  const now = Date.now();
  const iso24h = new Date(now - 86_400_000).toISOString();
  const iso7d = new Date(now - 7 * 86_400_000).toISOString();
  const count = (sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

  const activeTotal = count(`SELECT COUNT(*) AS n FROM job_leads WHERE closed_at IS NULL`);
  const closedTotal = count(`SELECT COUNT(*) AS n FROM job_leads WHERE closed_at IS NOT NULL`);

  const byStatus: Record<string, number> = {};
  for (const r of db
    .prepare(`SELECT status, COUNT(*) AS n FROM job_leads WHERE closed_at IS NULL GROUP BY status`)
    .all() as { status: string; n: number }[]) {
    byStatus[r.status] = r.n;
  }
  const bySource: Record<string, number> = {};
  for (const r of db
    .prepare(`SELECT source, COUNT(*) AS n FROM job_leads WHERE closed_at IS NULL GROUP BY source`)
    .all() as { source: string; n: number }[]) {
    bySource[r.source] = r.n;
  }

  const llmScored = count(`SELECT COUNT(*) AS n FROM job_leads WHERE closed_at IS NULL AND llm_score IS NOT NULL`);
  const pushed24h = count(`SELECT COUNT(*) AS n FROM job_leads WHERE killer_match_pushed_at >= ?`, iso24h);
  const added24h = count(`SELECT COUNT(*) AS n FROM job_leads WHERE first_seen_at >= ?`, iso24h);
  const added7d = count(`SELECT COUNT(*) AS n FROM job_leads WHERE first_seen_at >= ?`, iso7d);

  const newest = db.prepare(`SELECT MAX(first_seen_at) AS m FROM job_leads WHERE closed_at IS NULL`).get() as {
    m: string | null;
  };
  const newestAgeHours = newest.m ? Math.max(0, Math.floor((now - new Date(newest.m).getTime()) / 3_600_000)) : null;

  const leads = parseLeadReasons(
    db
      .prepare(
        `SELECT ${ADMIN_LEAD_COLS} FROM job_leads WHERE closed_at IS NULL ORDER BY rules_score DESC, first_seen_at DESC LIMIT ?`,
      )
      .all(ADMIN_LEADS_ACTIVE_CAP) as AdminLead[],
  );
  const closed = parseLeadReasons(
    db
      .prepare(`SELECT ${ADMIN_LEAD_COLS} FROM job_leads WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?`)
      .all(ADMIN_LEADS_CLOSED_CAP) as AdminLead[],
  );

  return {
    rollup: { activeTotal, closedTotal, byStatus, bySource, llmScored, pushed24h, added24h, added7d, newestAgeHours },
    leads,
    closed,
  };
}

/** Map a stored job_leads row to the JobLeadPayload subset computeRulesScore
 * reads, so a re-score recomputes the deterministic score from the CURRENT
 * normalized columns (not raw_payload, which is the un-normalized API response). */
function leadRowToScorePayload(row: Record<string, unknown>): JobLeadPayload {
  return {
    source: row.source as JobLeadPayload['source'],
    source_board_token: null,
    source_job_id: String(row.source_job_id ?? ''),
    source_url: String(row.source_url ?? ''),
    title: String(row.title ?? ''),
    company: String(row.company ?? ''),
    location_raw: (row.location_raw as string | null) ?? null,
    is_remote: row.is_remote == null ? null : Boolean(row.is_remote),
    remote_region: (row.remote_region as JobLeadPayload['remote_region']) ?? null,
    comp_min_usd: (row.comp_min_usd as number | null) ?? null,
    comp_max_usd: (row.comp_max_usd as number | null) ?? null,
    description_text: (row.description_text as string | null) ?? null,
    source_posted_at: (row.source_posted_at as string | null) ?? null,
  };
}

/** Recompute one lead's deterministic rules_score against an already-parsed
 * profile (so a bulk re-score parses the profile once). Returns null if gone. */
function rescoreLead(
  db: Database.Database,
  id: string,
  profile: CandidateProfileForScoring,
): { rules_score: number; reasons: Record<string, unknown> } | null {
  const row = db.prepare(`SELECT * FROM job_leads WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const { score, reasons } = computeRulesScore(leadRowToScorePayload(row), profile);
  db.prepare(`UPDATE job_leads SET rules_score = @score, rules_score_reasons = @reasons WHERE id = @id`).run({
    id,
    score,
    reasons: JSON.stringify(reasons),
  });
  return { rules_score: score, reasons };
}

function readScoringProfile(db: Database.Database): CandidateProfileForScoring {
  const row = db.prepare('SELECT * FROM candidate_profile WHERE id = 1').get() as Record<string, unknown> | null;
  return profileFromRow(row);
}

/**
 * The Leads tab write. One JSON action:
 *   { action: 'set_status', id, status, reason? } — owner triage (allow-listed
 *     statuses minus 'applied'); 'archived' soft-closes (closed_at + reason).
 *   { action: 'rescore', id }   — recompute one lead's deterministic rules_score
 *     against the current candidate_profile (never touches llm_score).
 *   { action: 'rescore_all' }   — the same recompute across all active leads.
 */
export function applyAdminLeadsWrite(db: Database.Database, raw: unknown): { status: number; body: unknown } {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { action }' } };
  }
  if (!hasTable(db, 'job_leads')) return { status: 404, body: { error: 'job_leads not migrated' } };
  const body = raw as { action?: unknown; id?: unknown; status?: unknown; reason?: unknown };
  const action = body.action;

  if (action === 'set_status') {
    const id = typeof body.id === 'string' ? body.id : '';
    const status = typeof body.status === 'string' ? body.status : '';
    const reason = typeof body.reason === 'string' ? body.reason : null;
    if (!id) return { status: 400, body: { error: 'id (string) is required' } };
    if (!OWNER_SETTABLE_LEAD_STATUSES.has(status)) {
      return { status: 400, body: { error: `status must be one of: ${[...OWNER_SETTABLE_LEAD_STATUSES].join(', ')}` } };
    }
    const existing = db.prepare('SELECT status FROM job_leads WHERE id = ?').get(id) as { status: string } | undefined;
    if (!existing) return { status: 404, body: { error: `no job_lead with id "${id}"` } };
    const now = new Date().toISOString();
    if (status === 'archived') {
      db.prepare(
        `UPDATE job_leads SET status = 'archived', status_changed_at = @now, closed_at = @now, closed_reason = @reason WHERE id = @id`,
      ).run({ id, now, reason: reason ?? 'manual' });
    } else {
      db.prepare(`UPDATE job_leads SET status = @status, status_changed_at = @now WHERE id = @id`).run({
        id,
        status,
        now,
      });
    }
    log.info('admin: job_lead status set', { id, from: existing.status, to: status });
    return { status: 200, body: { ok: true, id, from: existing.status, to: status } };
  }

  if (action === 'rescore') {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return { status: 400, body: { error: 'id (string) is required' } };
    const result = rescoreLead(db, id, readScoringProfile(db));
    if (!result) return { status: 404, body: { error: `no job_lead with id "${id}"` } };
    log.info('admin: job_lead rescored', { id, rules_score: result.rules_score });
    return {
      status: 200,
      body: { ok: true, id, rules_score: result.rules_score, rules_score_reasons: result.reasons },
    };
  }

  if (action === 'rescore_all') {
    const profile = readScoringProfile(db);
    const ids = (db.prepare(`SELECT id FROM job_leads WHERE closed_at IS NULL`).all() as { id: string }[]).map(
      (r) => r.id,
    );
    let rescored = 0;
    db.transaction(() => {
      for (const id of ids) {
        if (rescoreLead(db, id, profile)) rescored += 1;
      }
    })();
    log.info('admin: job_leads rescored (all active)', { rescored });
    return { status: 200, body: { ok: true, rescored } };
  }

  return { status: 400, body: { error: `unknown action: ${String(action)}` } };
}
