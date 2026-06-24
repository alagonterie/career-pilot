/**
 * src/modules/portal/api.ts — the public portal HTTP API.
 *
 * A native-`http` server (NOT Express — reuses the `src/webhook-server.ts`
 * lifecycle pattern; no web-framework dependency, and SSE in 5.2 is more
 * natural in raw node). Started by the host on 127.0.0.1:<port> (default 3001),
 * behind Cloudflare Tunnel at api.hire.<DOMAIN>.
 *
 * Sub-milestone 5.1 (STRATEGY.md §24.15) — read-only endpoints over the
 * already-built public tables:
 *   GET /api/pipeline          public_pipeline_view + read-time-computed days + stage_counts
 *   GET /api/activity        public_audit_trail, paginated by the monotonic seq cursor
 *   GET /api/system-status   live_mode / pause_state / pause_reason / backend
 *
 * The API reads ONLY public tables (never `applications` / `learnings` / etc.).
 *
 * Auth is staged: this ships a dev-open `checkAuth()` chokepoint + a CORS
 * allow-list. The §10 triple-defense (CF-Access service-auth + JWT via `jose`
 * + AOP mTLS) drops into `checkAuth()` at the deploy phase. Safe pre-deploy
 * because every served row is sanitized public data.
 *
 * Sub-milestone 5.5a (STRATEGY.md §24.19) adds the simulator entry point:
 *   POST /api/simulator   { company, role, jd?, public_url? } → { simulation_id }
 * which spawns a per-thread sandbox session via the portal channel adapter.
 * The simulator SSE stream (/api/simulator/:id/stream) + results endpoint land
 * in 5.5b/5.5c.
 *
 * Later sub-milestones add: telemetry/architecture (done, 5.3), simulator
 * streams (5.5b), results (5.5c). See STRATEGY.md §10 + §24.15 + §24.19.
 */
import http from 'http';

import { ensureMasterPdfLink, recordVisit, resolveLink } from '../../attribution.js';
import { getDb } from '../../db/connection.js';
import { countRunningContainers } from '../../container-runtime.js';
import { getActiveSessions, getRunningSessions } from '../../db/sessions.js';
import { getLastSweepAtMs } from '../../host-sweep.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { runHealthChecks } from '../career-pilot/health.js';
import { loadState, simStatePath } from '../career-pilot/recruiter-sim/runner.js';

import { validateAccessJwt } from './access-jwt.js';
import {
  adminEnabled,
  applyAdminControl,
  applyAdminKnobWrite,
  applyAdminSandboxRunDelete,
  buildAdminContacts,
  buildAdminKnobs,
  buildAdminPipeline,
  buildAdminSandboxRuns,
  buildAdminSummary,
  buildAttributionReport,
} from './admin.js';
import { relayContactSubmission, type ContactInput } from './contact-relay.js';
import {
  applyDevControl,
  applyDevReset,
  applyDevSweep,
  applyKnobWrite,
  buildDevKnobs,
  buildDevPersonaFromDb,
  buildDevState,
  isDevEnv,
} from './dev-inspector.js';
import { computeRunningTopology, emptyObservability, getObservability, sandboxSpend24hUsd } from './observability.js';
import { getTelemetry } from './portkey-analytics.js';
import { getPublicProfile, type WorkProfile } from './profile.js';
import { masterFooter, renderResumePdf, tailoredFooter } from './resume-pdf.js';
import { buildSanitizeDemo } from './sanitize-demo.js';
import { getRecentSimulatorRuns, getSimulatorResult, startSimulatorRun, type SimulatorInput } from './simulator.js';
import {
  addActivityClient,
  addSimulatorClient,
  removeActivityClient,
  removeSimulatorClient,
  stopBroadcaster,
} from './sse-broadcaster.js';
import { getSystemStatus } from './system-modes.js';

const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_CORS_ORIGINS = ['http://localhost:3000'];
const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 200;
const MS_PER_DAY = 86_400_000;

let server: http.Server | null = null;

// ── helpers ────────────────────────────────────────────────────────────────

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {};
  let allowed: string[];
  try {
    allowed = getConfig<string[]>(getDb(), 'portal_cors_origins', DEFAULT_CORS_ORIGINS);
  } catch {
    allowed = DEFAULT_CORS_ORIGINS;
  }
  if (Array.isArray(allowed) && allowed.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }
  return {};
}

function json(res: http.ServerResponse, status: number, body: unknown, cors: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
  res.end(JSON.stringify(body));
}

/**
 * The single auth chokepoint. Dev-open in 5.1; the §10 CF-Access JWT
 * validation (`jose` against the team JWKS) drops in here at the deploy phase.
 */
function checkAuth(_req: http.IncomingMessage): { ok: boolean; reason?: string } {
  return { ok: true };
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

const MAX_BODY_BYTES = 64 * 1024;

/** Read + JSON-parse a request body (size-capped). Rejects on overflow/bad JSON. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ── route handlers ───────────────────────────────────────────────────────

interface PipelineViewRow {
  application_id: string;
  application_ref: string;
  public_state: string;
  role_title: string | null;
  status: string;
  stage: string;
  applied_at: string | null;
  stage_entered_at: string | null;
  last_activity_at: string | null;
  win_confidence: number | null;
  win_confidence_rationale: string | null;
  published_learning: string | null;
  learnings_json: string | null;
  kits_json: string | null;
}

/** Parse a public_pipeline_view kits_json column into the API's interview_kits array. */
function parseKitsJson(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse `learnings_json` into the API's `learnings` array (§24.117). Falls back
 * to synthesizing a single-element array from the legacy `published_learning`
 * excerpt when `learnings_json` is null (a row not yet re-projected after
 * migration 139) — so no published note disappears in the deploy gap and the FE
 * has one code path.
 */
function parseLearnings(learningsJson: string | null, publishedLearning: string | null): unknown[] {
  if (learningsJson) {
    try {
      const parsed = JSON.parse(learningsJson);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to the published_learning synthesize */
    }
  }
  if (publishedLearning) return [{ kind: null, created_at: null, excerpt: publishedLearning }];
  return [];
}

function handlePipeline(res: http.ServerResponse, cors: Record<string, string>): void {
  const rows = getDb()
    .prepare(
      `SELECT application_id, application_ref, public_state, role_title, status, stage,
              applied_at, stage_entered_at, last_activity_at, win_confidence,
              win_confidence_rationale, published_learning, learnings_json, kits_json
         FROM public_pipeline_view`,
    )
    .all() as PipelineViewRow[];

  const now = Date.now();
  const applications = rows.map(({ kits_json, learnings_json, ...r }) => ({
    ...r,
    days_in_stage: daysSince(r.stage_entered_at, now),
    days_in_pipeline: daysSince(r.applied_at, now),
    // §24.65: per-kit existence metadata for the drawer's "Interview prep"
    // section — enums + timestamps only; kit CONTENT rides /api/kit, never
    // this polled payload.
    interview_kits: parseKitsJson(kits_json),
    // §24.117: ALL published reflections for the drawer's "Lessons learned"
    // list (kind/created_at/excerpt) — the rejection-as-fuel loop made visible.
    learnings: parseLearnings(learnings_json, r.published_learning),
  }));

  const stage_counts: Record<string, number> = {};
  for (const r of rows) {
    stage_counts[r.stage] = (stage_counts[r.stage] ?? 0) + 1;
  }

  // §24.149 L2: the site lifecycle rides the pipeline read-model (the one endpoint
  // both / and /pipeline already poll), so the public retrospective needs no new
  // fetch. A preference-tier flag, owner-flipped from /admin; default 'active'.
  const site_lifecycle =
    getConfig<string>(getDb(), 'site_lifecycle_state', 'active') === 'concluded' ? 'concluded' : 'active';

  json(res, 200, { applications, stage_counts, site_lifecycle }, cors);
}

/**
 * §24.71 / 9.4b-1: the `/work` profile projection. Serves the agent-composed
 * (or hand-seeded) `WorkProfile` blob from `candidate_profile`, or
 * `{ profile: null }` when unset → the frontend renders its typed placeholder.
 * Read-only over an already-private table; no LLM at read-time (the agent
 * composes at write-time, §24.71 D1).
 */
function handleProfile(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, getPublicProfile(), cors);
}

/**
 * `GET /api/resume.pdf` — server-rendered résumé from the composed `WorkProfile`
 * (STRATEGY §24.72 / 9.4b-r1). 404 when no profile is composed (the `/work`
 * download button is hidden in that case) — we never emit a placeholder résumé.
 * Streamed binary; the Worker BFF passes it through byte-clean.
 */
async function handleResumePdf(res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
  const { profile, identity } = getPublicProfile();
  if (!profile) {
    json(res, 404, { error: 'no_profile' }, cors);
    return;
  }
  const url = getConfig<string>(getDb(), 'portal_public_url', '');
  // §24.74: route the footer's host link through a stable /r/<code> token so a
  // FORWARDED master résumé attributes its click-throughs (the displayed host
  // stays bare). Only when a public URL is configured (else there's no footer
  // link to tokenize); best-effort — a mint failure falls back to the plain host.
  let footerLinkUrl: string | undefined;
  if (url) {
    const link = ensureMasterPdfLink();
    if (link) footerLinkUrl = url.replace(/\/$/, '') + link.path;
  }
  const buf = await renderResumePdf(profile, identity, masterFooter(url), url, { footerLinkUrl });
  const base = profile.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resume';
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${base}.pdf"`,
    'Content-Length': String(buf.length),
    // The URL ends in `.pdf` → Cloudflare edge-caches it by default; no-store
    // stops a stale résumé being served after the profile/renderer changes.
    'Cache-Control': 'no-store',
    ...cors,
  });
  res.end(buf);
}

/**
 * `GET /r/<code>` — resolve a minted attribution link (§24.74): record one
 * first-party visit, then 302 to the link's destination (always '/'). The
 * visitor stays anonymous — the Worker proxies `/r/*` here with the service
 * token + the CF signals as `x-cp-*` headers (the same D12 model as `/api/*`).
 * An unknown/expired code still lands the visitor on '/', but records nothing
 * (no noise, no probe surface). The redirect target is DB-controlled + checked
 * relative ('/...') so it can never be an open redirect.
 */
function handleAttributionRedirect(
  req: http.IncomingMessage,
  code: string,
  res: http.ServerResponse,
  cors: Record<string, string>,
): void {
  const link = resolveLink(code);
  const dest = link && link.dest_path.startsWith('/') && !link.dest_path.startsWith('//') ? link.dest_path : '/';
  if (link) {
    const h = req.headers;
    recordVisit({
      linkCode: link.code,
      path: dest,
      ip: (h['x-cp-client-ip'] as string | undefined) ?? null,
      country: (h['x-cp-country'] as string | undefined) ?? null,
      userAgent: (h['user-agent'] as string | undefined) ?? null,
      referrer: (h['referer'] as string | undefined) ?? null,
    });
  }
  res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store', ...cors });
  res.end();
}

/**
 * `GET /api/admin/attribution` (§24.74 D5) — the owner-only attribution browser:
 * minted `/r/<code>` links joined to their visit_telemetry clicks + the recent
 * visit feed. Reachability is gated upstream (`adminEnabled()` in the dispatch);
 * this just renders the read-model.
 */
function handleAdminAttribution(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildAttributionReport(getDb()), cors);
}

// ── §24.138: the /admin control-center read + write surface ───────────────────
// All reachability-gated by adminEnabled() in the dispatch (dev → open; prod →
// admin_api_enabled AND origin-JWT). Reads are owner-view (real names); the knob
// write enforces the ADMIN_DENY deny-list with a 403, and the mode controls
// confirm-gate the destructive actions.

async function handleAdminSummary(res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
  json(res, 200, await buildAdminSummary(getDb()), cors);
}

function handleAdminPipeline(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildAdminPipeline(getDb()), cors);
}

function handleAdminContacts(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildAdminContacts(getDb()), cors);
}

/** §24.164: the owner-only Sandbox-runs read (full detail; the inverse of the
 *  public metrics-only feed). Reachability is gated upstream by adminEnabled(). */
function handleAdminSandboxRuns(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildAdminSandboxRuns(), cors);
}

/** §24.164: early-delete one sandbox run (purge before its TTL). */
async function handleAdminSandboxRunDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' }, cors);
  }
  const out = applyAdminSandboxRunDelete(body);
  json(res, out.status, out.body, cors);
}

function handleAdminKnobs(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildAdminKnobs(getDb()), cors);
}

async function handleAdminKnobsWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' }, cors);
  }
  const out = applyAdminKnobWrite(getDb(), body);
  json(res, out.status, out.body, cors);
}

async function handleAdminControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' }, cors);
  }
  const out = await applyAdminControl(getDb(), body);
  json(res, out.status, out.body, cors);
}

/**
 * §24.65: one kit's public projection for the /kit dossier page.
 * `?app=«application_ref»&round=«ROUND»` — the ref is the public key the
 * frontend holds (same first-match resolution rule as the /pipeline drawer;
 * the two-public-apps-one-company collision is the accepted §24.62 behavior).
 * Reads ONLY public tables (public_pipeline_view → public_kit_view); sealed
 * sections carry counts + captions, never text. 404 when absent.
 */
function handleKit(url: URL, res: http.ServerResponse, cors: Record<string, string>): void {
  const ref = url.searchParams.get('app') ?? '';
  const round = (url.searchParams.get('round') ?? '').toUpperCase();
  if (!ref || !round) {
    json(res, 400, { error: 'bad_request', message: 'app and round query params are required' }, cors);
    return;
  }

  const db = getDb();
  const app = db
    .prepare(
      `SELECT application_id, application_ref, public_state, role_title
         FROM public_pipeline_view WHERE application_ref = ? LIMIT 1`,
    )
    .get(ref) as
    | { application_id: string; application_ref: string; public_state: string; role_title: string | null }
    | undefined;
  if (!app) {
    json(res, 404, { error: 'not_found' }, cors);
    return;
  }

  const kit = db
    .prepare(
      `SELECT round, interview_type, interview_at, status, sections_json, updated_at
         FROM public_kit_view WHERE application_id = ? AND round = ?`,
    )
    .get(app.application_id, round) as
    | {
        round: string;
        interview_type: string;
        interview_at: string | null;
        status: string;
        sections_json: string;
        updated_at: string;
      }
    | undefined;
  if (!kit) {
    json(res, 404, { error: 'not_found' }, cors);
    return;
  }

  let sections: unknown[] = [];
  try {
    const parsed = JSON.parse(kit.sections_json);
    if (Array.isArray(parsed)) sections = parsed;
  } catch {
    sections = [];
  }

  json(
    res,
    200,
    {
      application_ref: app.application_ref,
      public_state: app.public_state,
      role_title: app.role_title,
      round: kit.round,
      interview_type: kit.interview_type,
      interview_at: kit.interview_at,
      status: kit.status,
      sections,
    },
    cors,
  );
}

function handleActivity(url: URL, res: http.ServerResponse, cors: Record<string, string>): void {
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? parseInt(sinceRaw, 10) : 0;
  const limitRaw = url.searchParams.get('limit');
  let limit = limitRaw != null && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : ACTIVITY_DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), ACTIVITY_MAX_LIMIT);

  const events = getDb()
    .prepare(
      `SELECT seq, ts, category, agent_name, proactive, application_ref, model_used,
              tokens, cost_cents, cache_hit, cache_read_pct, latency_ms, summary
         FROM public_audit_trail
        WHERE seq > @since
        ORDER BY seq ASC
        LIMIT @limit`,
    )
    .all({ since, limit }) as Array<{ seq: number }>;

  const next_since = events.length > 0 ? events[events.length - 1].seq : since;
  json(res, 200, { events, next_since }, cors);
}

function handleSystemStatus(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, getSystemStatus(), cors);
}

async function handleTelemetry(res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
  json(res, 200, await getTelemetry(), cors);
}

/**
 * /api/observability (§24.69) — per-class 24h spend, per-provider health, and
 * session topology, aggregated from the private `request_telemetry` table. The
 * served payload is aggregate-only (no per-request rows, no error/session/trace
 * fields) — the §9 boundary is held by the projection in observability.ts.
 */
async function handleObservability(res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
  json(res, 200, await getObservability(), cors);
}

// Short cache around the (blocking) `docker ps` call so repeated /api/architecture
// hits don't stall the event loop. Sessions are a cheap DB read — computed fresh.
let dockerCache: { at: number; value: number | null } | null = null;

function countRunningContainersCached(): number | null {
  // Dev/demo seam (§24.26): the fixture/demo server injects a count so the
  // /architecture container widget renders "up". Checked before the cache +
  // `docker ps`. Inert in prod (the env is never set there).
  const mock = process.env.PORTAL_MOCK_CONTAINERS;
  if (mock != null && /^\d+$/.test(mock)) return parseInt(mock, 10);
  let ttl = 5000;
  try {
    ttl = getConfig<number>(getDb(), 'portal_architecture_cache_ms', 5000);
  } catch {
    ttl = 5000;
  }
  if (dockerCache && Date.now() - dockerCache.at < ttl) return dockerCache.value;
  const value = countRunningContainers();
  dockerCache = { at: Date.now(), value };
  return value;
}

function handleArchitecture(res: http.ServerResponse, cors: Record<string, string>): void {
  const active = getActiveSessions().length;
  const running = getRunningSessions().length;
  const containerCount = countRunningContainersCached();

  let capacityMax = 4;
  let memoryMbEach = 512;
  // §24.80 probe inputs (host-tier config; FE folds them into node status).
  let simulatorEnabled = true;
  let sandboxBudgetUsd = 5;
  let sweepStaleSec = 180;
  try {
    const db = getDb();
    capacityMax = getConfig<number>(db, 'container_max_concurrent', 4);
    memoryMbEach = getConfig<number>(db, 'container_memory_mb', 512);
    simulatorEnabled = getConfig<boolean>(db, 'simulator_enabled', true);
    sandboxBudgetUsd = getConfig<number>(db, 'sandbox_daily_global_budget_usd', 5);
    sweepStaleSec = getConfig<number>(db, 'arch_sweep_stale_sec', 180);
  } catch {
    // defaults
  }

  // §24.80 Web-sandbox probe: kill switch + 24 h sandbox spend vs the daily cap.
  const sandboxSpendUsd = sandboxSpend24hUsd();
  // §24.80 Cron-sweep probe: age of the last completed sweep tick; `fresh` keeps
  // the (host-tier) staleness threshold backend-side, so the FE just renders.
  const lastSweepAt = getLastSweepAtMs();
  const sweepAgeSec = lastSweepAt === null ? null : Math.max(0, Math.floor((Date.now() - lastSweepAt) / 1000));

  json(
    res,
    200,
    {
      sessions: { active, running },
      containers: {
        running: containerCount,
        capacity_max: capacityMax,
        memory_mb_each: memoryMbEach,
        runtime: containerCount === null ? 'down' : 'up',
        // §24.110: running containers split by traffic class — the /dashboard
        // memory bar segments by this. Derived from running sessions.
        by_class: computeRunningTopology(),
      },
      sandbox: {
        enabled: simulatorEnabled,
        spend_24h_usd: sandboxSpendUsd,
        daily_budget_usd: sandboxBudgetUsd,
      },
      sweep: {
        last_run_age_sec: sweepAgeSec,
        fresh: sweepAgeSec !== null && sweepAgeSec <= sweepStaleSec,
      },
      backend: 'online',
    },
    cors,
  );
}

async function handleSimulatorStart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: 'bad_request', message: 'invalid or oversized JSON body' }, cors);
    return;
  }
  const input: SimulatorInput = body && typeof body === 'object' ? (body as SimulatorInput) : {};
  // The CF-verified visitor IP the Worker BFF forwards (§24.70). Always set by the
  // Worker (overwriting any client value); used for the per-IP daily run cap.
  const ipHeader = req.headers['x-cp-client-ip'];
  const ip = typeof ipHeader === 'string' && ipHeader.trim() ? ipHeader.trim() : null;
  const result = startSimulatorRun(input, ip);
  if (result.ok) {
    json(res, 200, { simulation_id: result.simulation_id }, cors);
    return;
  }
  const status = result.error?.code === 'BAD_ARGS' ? 400 : result.error?.code === 'RATE_LIMITED' ? 429 : 503;
  // `reason` (§24.150) brands the frontend's "degradation-as-a-feature" fallback;
  // the HTTP status + `error` code stay unchanged for back-compat.
  json(
    res,
    status,
    { error: result.error?.code ?? 'error', reason: result.error?.reason, message: result.error?.message },
    cors,
  );
}

/** Contact relay (5.6) — POST /api/contact → owner channel. One-way; 200/400/503. */
async function handleContact(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: 'bad_request', message: 'invalid or oversized JSON body' }, cors);
    return;
  }
  const input: ContactInput = body && typeof body === 'object' ? (body as ContactInput) : {};
  const result = await relayContactSubmission(input);
  if (result.ok) {
    json(res, 200, { ok: true }, cors);
    return;
  }
  const status = result.error?.code === 'BAD_ARGS' ? 400 : 503;
  json(res, status, { error: result.error?.code ?? 'error', message: result.error?.message }, cors);
}

/**
 * Anonymization demo (§24.33) — POST /api/sanitize-demo. Runs the REAL sanitizer
 * (applyPass1 + redactCompanies) over a server-authored SYNTHETIC sample so the
 * /live wow-finish can't drift from the real pipeline. Effect-free; body
 * `{ sample?: number }` selects (clamped). Lenient on an empty/invalid body.
 */
async function handleSanitizeDemo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const sample = body && typeof body === 'object' ? (body as { sample?: unknown }).sample : undefined;
  json(res, 200, buildSanitizeDemo(typeof sample === 'number' ? sample : 0), cors);
}

/** Shareable cached run for /simulator/results/:id (5.5c). 404 when absent/expired. */
function handleSimulatorResult(res: http.ServerResponse, runId: string, cors: Record<string, string>): void {
  const row = getSimulatorResult(runId);
  if (!row) {
    json(res, 404, { error: 'not_found' }, cors);
    return;
  }
  // Don't ship the full tailored WorkProfile to the client (it renders to a PDF
  // server-side, §24.72 9.4b-r2); expose only whether the download is available.
  const { tailored_resume_json, ...rest } = row;
  json(res, 200, { ...rest, has_tailored_resume: tailored_resume_json != null }, cors);
}

/**
 * `GET /api/simulator/results/<id>/resume.pdf` — the Tier-2 tailored résumé
 * (§24.72 9.4b-r2): render the run's guardrail-validated tailored `WorkProfile`
 * with the company/role footer (D4). 404 when the run has no tailored résumé
 * (pre-r2 rows, or the guardrail rejected the emission).
 */
async function handleSimulatorResumePdf(
  res: http.ServerResponse,
  runId: string,
  cors: Record<string, string>,
): Promise<void> {
  const row = getSimulatorResult(runId);
  if (!row || !row.tailored_resume_json) {
    json(res, 404, { error: 'no_tailored_resume' }, cors);
    return;
  }
  let tailored: WorkProfile;
  try {
    tailored = JSON.parse(row.tailored_resume_json) as WorkProfile;
  } catch {
    json(res, 404, { error: 'no_tailored_resume' }, cors);
    return;
  }
  const { identity } = getPublicProfile();
  const url = getConfig<string>(getDb(), 'portal_public_url', '');
  const buf = await renderResumePdf(
    tailored,
    identity,
    tailoredFooter(row.visitor_company, row.visitor_role, row.ts, url),
    url,
    // Tailored content runs marginally longer than the master (role summary + an
    // extra target-role line) — compact density keeps it to one page.
    { compact: true },
  );
  const base =
    `${tailored.name}-${row.visitor_company ?? 'tailored'}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
    'resume';
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    // `inline` (not `attachment`) so the gift can render in an in-browser <iframe>
    // preview before download; the download buttons set the `download` attribute,
    // which forces a save same-origin regardless of this disposition.
    'Content-Disposition': `inline; filename="${base}.pdf"`,
    'Content-Length': String(buf.length),
    // The URL ends in `.pdf` → Cloudflare edge-caches it by default; no-store
    // stops a stale résumé being served after the profile/renderer changes.
    'Cache-Control': 'no-store',
    ...cors,
  });
  res.end(buf);
}

/** Recent shareable runs (metadata) for the disabled-simulator fallback (5.5c). */
function handleSimulatorRecent(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, { runs: getRecentSimulatorRuns() }, cors);
}

function handleActivityStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  cors: Record<string, string>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx/CF)
    ...cors,
  });
  // Flush headers now so the stream is established even before the first event
  // (Node otherwise buffers headers until the first body write).
  res.flushHeaders();

  // Resume cursor: Last-Event-ID (EventSource auto-sets on reconnect) or ?since.
  // Absent → start live from the current max (no history dump; that's /api/activity).
  const lastEventId = req.headers['last-event-id'];
  const sinceQ = url.searchParams.get('since');
  let cursor: number | null = null;
  if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
    cursor = parseInt(lastEventId, 10);
  } else if (sinceQ != null && /^\d+$/.test(sinceQ)) {
    cursor = parseInt(sinceQ, 10);
  }

  addActivityClient(res, cursor);
  req.on('close', () => removeActivityClient(res));
}

/**
 * SSE stream for a single simulator run (§24.20). Push-based: the portal
 * channel adapter pushes trace/chat/task events as the sandbox session's
 * outbound rows drain. No backlog — the visitor watches live from connect.
 */
function handleSimulatorStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  cors: Record<string, string>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors,
  });
  res.flushHeaders();
  addSimulatorClient(runId, res);
  req.on('close', () => removeSimulatorClient(runId, res));
}

// ── mock-only async-state override seam (§24.36 / Sub-milestone 36.1) ───────
//
// dev/E2E ONLY: when PORTAL_MOCK_STATE_SEAM=1 (set by scripts/portal-dev-server.ts
// + scripts/portal-e2e-server.ts, never in production), a `?__state=loading|empty
// |error` query forces the matching async state so the loading/empty/error UIs
// are reachable in dev (the state-switcher) and snapshottable in @visual. The
// production API never sets the flag, so this is dead code in prod and `__state`
// is ignored even if a visitor appends it (PORTAL §10 / V2_IDEAS #16).
type ForcedState = 'loading' | 'empty' | 'error';

function parseForcedState(url: URL): ForcedState | null {
  if (process.env.PORTAL_MOCK_STATE_SEAM !== '1') return null;
  const v = url.searchParams.get('__state');
  return v === 'loading' || v === 'empty' || v === 'error' ? v : null;
}

/** A valid-but-empty payload per read endpoint — the "system is real but quiet"
 * preview state (0 applications / idle sessions / no telemetry). */
function emptyPayloadFor(path: string): unknown {
  switch (path) {
    case '/api/pipeline':
      return { applications: [], stage_counts: {} };
    case '/api/activity':
      return { events: [], next_since: 0 };
    case '/api/architecture':
      return {
        sessions: { active: 0, running: 0 },
        containers: {
          running: 0,
          capacity_max: 0,
          memory_mb_each: 0,
          runtime: 'up',
          by_class: { chat: 0, ops: 0, sandbox: 0 },
        },
        // §24.80: a bare/quiet system — sandbox enabled but unused, sweep not yet ticked.
        sandbox: { enabled: true, spend_24h_usd: 0, daily_budget_usd: 0 },
        sweep: { last_run_age_sec: null, fresh: false },
        backend: 'online',
      };
    case '/api/system-status':
      return { live_mode: false, pause_state: 'active', pause_reason: null, backend: 'online' };
    case '/api/observability':
      return emptyObservability();
    case '/api/telemetry':
      return {
        local: {
          simulator_runs_total: 0,
          activity_events_total: 0,
          activity_events_24h: 0,
          agent_actions_24h: 0,
          last_activity_at: null,
          turns_total: 0,
          turns_24h: 0,
          turn_cost_cents_total: 0,
          turn_cost_cents_24h: 0,
          sim_cost_cents_total: 0,
          sim_cost_cents_24h: 0,
          cache_hit_rate: null,
          turn_p50_ms: null,
          turn_p95_ms: null,
          top_model: null,
        },
      };
    default:
      return {};
  }
}

function applyForcedState(
  state: ForcedState,
  path: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): void {
  const isStream = path.endsWith('/stream');
  if (state === 'loading') {
    // Hold the request open so the client stays in its loading/connecting state.
    // The client aborts on unmount / when the override changes; the socket closes
    // then. Swallow the abort-reset so it doesn't surface as an error.
    req.on('error', () => {});
    return;
  }
  if (state === 'error') {
    // JSON 500 → polled hooks show the error state; for an SSE endpoint the
    // stream client sees a non-ok response and surfaces its reconnecting state.
    json(res, 500, { error: 'forced_error', __state: 'error' }, cors);
    return;
  }
  // state === 'empty'
  if (isStream) {
    // Open the stream but register no client → zero events → the empty state.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...cors,
    });
    res.flushHeaders();
    // Establish immediately (parity with addActivityClient): flushHeaders alone
    // doesn't defeat proxy buffering — only a body byte does. Harmless locally
    // (this dev/E2E seam isn't proxied), but keeps dev↔prod stream behavior identical.
    res.write(': open\n\n');
    const ka = setInterval(() => {
      if (!res.writableEnded) res.write(': ka\n\n');
    }, 15_000);
    ka.unref();
    req.on('close', () => clearInterval(ka));
    return;
  }
  json(res, 200, emptyPayloadFor(path), cors);
}

// ── dev inspector (§24.42b) — hard-gated `ENVIRONMENT==='dev'`, owner-only ──

function handleDevState(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildDevState(getDb(), loadState(simStatePath())), cors);
}

function handleDevKnobs(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildDevKnobs(getDb()), cors);
}

async function handleDevKnobsWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' }, cors);
  }
  const out = applyKnobWrite(getDb(), body);
  json(res, out.status, out.body, cors);
}

function handleDevPersona(res: http.ServerResponse, cors: Record<string, string>): void {
  json(res, 200, buildDevPersonaFromDb(), cors);
}

/**
 * /api/dev/health (§24.69 D8) — the §24.68 health-check report in the browser,
 * owner-only (dev-gated by the `/api/dev/*` prefix). `skipLiveProbes` because
 * the polled path must not exec/spend on the Gmail/gateway probe — those stay
 * CLI-only (`pnpm health`). Findings carry their `next_step` runbook command.
 */
async function handleDevHealth(res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
  const report = await runHealthChecks({ skipLiveProbes: true });
  json(res, 200, report, cors);
}

async function handleDevControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' }, cors);
  }
  const out = applyDevControl(getDb(), body);
  json(res, out.status, out.body, cors);
}

async function handleDevSweep(res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
  const out = await applyDevSweep();
  json(res, out.status, out.body, cors);
}

async function handleDevReset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' }, cors);
  }
  const out = applyDevReset(getDb(), body);
  json(res, out.status, out.body, cors);
}

// ── request router ───────────────────────────────────────────────────────

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const cors = corsHeaders(req);
  try {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Origin-side Cloudflare Access JWT (§24.70 D2) — the Layer-3 defense-in-depth
    // for the tunnel topology (AOP/mTLS doesn't apply). Inert unless
    // origin_jwt_validation_enabled + CF_ACCESS_TEAM/AUD are set (deployed stacks);
    // local/test pass straight through.
    if (!(await validateAccessJwt(req.headers['cf-access-jwt-assertion'] as string | undefined))) {
      json(res, 403, { error: 'forbidden' }, cors);
      return;
    }

    const auth = checkAuth(req);
    if (!auth.ok) {
      json(res, 401, { error: 'unauthorized', reason: auth.reason ?? null }, cors);
      return;
    }

    // Mock-only async-state override (§24.36 36.1) — dev/E2E only; inert in prod.
    const forced = method === 'GET' ? parseForcedState(url) : null;
    if (forced) return applyForcedState(forced, path, req, res, cors);

    if (method === 'GET' && path === '/api/pipeline') return handlePipeline(res, cors);
    if (method === 'GET' && path === '/api/profile') return handleProfile(res, cors);
    if (method === 'GET' && path === '/api/resume.pdf') return await handleResumePdf(res, cors);
    // §24.74 attribution redirect — `/r/<code>` (not under /api/*; the Worker
    // proxies it here with the CF signals). Resolve → record → 302 to '/'.
    if (method === 'GET' && path.startsWith('/r/')) {
      const code = path.slice('/r/'.length);
      if (code.length > 0 && !code.includes('/')) return handleAttributionRedirect(req, code, res, cors);
    }
    if (method === 'GET' && path === '/api/kit') return handleKit(url, res, cors);
    if (method === 'GET' && path === '/api/activity/stream') return handleActivityStream(req, res, url, cors);
    if (method === 'GET' && path === '/api/activity') return handleActivity(url, res, cors);
    if (method === 'GET' && path === '/api/telemetry') return await handleTelemetry(res, cors);
    if (method === 'GET' && path === '/api/observability') return await handleObservability(res, cors);
    if (method === 'GET' && path === '/api/architecture') return handleArchitecture(res, cors);
    if (method === 'GET' && path === '/api/system-status') return handleSystemStatus(res, cors);
    if (method === 'POST' && path === '/api/contact') return await handleContact(req, res, cors);
    if (method === 'POST' && path === '/api/sanitize-demo') return await handleSanitizeDemo(req, res, cors);
    if (method === 'POST' && path === '/api/simulator') return await handleSimulatorStart(req, res, cors);
    if (method === 'GET' && path === '/api/simulator/recent') return handleSimulatorRecent(res, cors);
    if (method === 'GET' && path.startsWith('/api/simulator/results/')) {
      const rest = path.slice('/api/simulator/results/'.length);
      if (rest.endsWith('/resume.pdf')) {
        const id = rest.slice(0, -'/resume.pdf'.length);
        if (id.length > 0) return await handleSimulatorResumePdf(res, id, cors);
      } else if (rest.length > 0) {
        return handleSimulatorResult(res, rest, cors);
      }
    }
    if (method === 'GET' && path.startsWith('/api/simulator/') && path.endsWith('/stream')) {
      const runId = path.slice('/api/simulator/'.length, -'/stream'.length);
      if (runId.length > 0) return handleSimulatorStream(req, res, runId, cors);
    }

    // Owner-only /admin surface (§24.74 D5): OPEN on dev (the surface is
    // owner-Access-gated), FAIL-CLOSED → 404 elsewhere until the owner wires the
    // prod /admin Access app + flips admin_api_enabled. Read-only; no sim/dev
    // knobs/destructive ops here by design.
    if (path.startsWith('/api/admin/')) {
      if (!adminEnabled()) return json(res, 404, { error: 'not_found', path }, cors);
      if (method === 'GET' && path === '/api/admin/attribution') return handleAdminAttribution(res, cors);
      if (method === 'GET' && path === '/api/admin/summary') return await handleAdminSummary(res, cors);
      if (method === 'GET' && path === '/api/admin/pipeline') return handleAdminPipeline(res, cors);
      if (method === 'GET' && path === '/api/admin/contacts') return handleAdminContacts(res, cors);
      if (method === 'GET' && path === '/api/admin/sandbox-runs') return handleAdminSandboxRuns(res, cors);
      if (method === 'POST' && path === '/api/admin/sandbox-runs')
        return await handleAdminSandboxRunDelete(req, res, cors);
      if (method === 'GET' && path === '/api/admin/knobs') return handleAdminKnobs(res, cors);
      if (method === 'POST' && path === '/api/admin/knobs') return await handleAdminKnobsWrite(req, res, cors);
      if (method === 'POST' && path === '/api/admin/control') return await handleAdminControl(req, res, cors);
    }

    // Dev inspector (§24.42b): the whole `/api/dev/*` prefix is invisible
    // (404) unless this is the dev stack — the non-negotiable PII guard.
    if (path.startsWith('/api/dev/')) {
      if (!isDevEnv()) return json(res, 404, { error: 'not_found', path }, cors);
      if (method === 'GET' && path === '/api/dev/state') return handleDevState(res, cors);
      if (method === 'GET' && path === '/api/dev/knobs') return handleDevKnobs(res, cors);
      if (method === 'POST' && path === '/api/dev/knobs') return await handleDevKnobsWrite(req, res, cors);
      if (method === 'GET' && path === '/api/dev/persona') return handleDevPersona(res, cors);
      if (method === 'GET' && path === '/api/dev/health') return await handleDevHealth(res, cors);
      if (method === 'POST' && path === '/api/dev/control') return await handleDevControl(req, res, cors);
      if (method === 'POST' && path === '/api/dev/sweep') return await handleDevSweep(res, cors);
      if (method === 'POST' && path === '/api/dev/reset') return await handleDevReset(req, res, cors);
    }

    json(res, 404, { error: 'not_found', path }, cors);
  } catch (err) {
    log.error('portal API handler error', { url: req.url, err });
    try {
      json(res, 500, { error: 'internal_error' }, cors);
    } catch {
      // response already partially sent — nothing more we can do
    }
  }
}

// ── lifecycle (mirrors src/webhook-server.ts) ────────────────────────────

/**
 * Start the portal API server. Idempotent — a second call resolves with the
 * already-bound port. Pass `{ port: 0 }` (and `host: '127.0.0.1'`) in tests to
 * bind an ephemeral port; the resolved `port` is the actual one.
 */
export function startPortalApi(opts: { port?: number; host?: string } = {}): Promise<{ port: number }> {
  if (server) {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : (opts.port ?? DEFAULT_PORT);
    return Promise.resolve({ port: boundPort });
  }

  let port = opts.port;
  if (port == null) {
    try {
      port = getConfig<number>(getDb(), 'portal_api_port', DEFAULT_PORT);
    } catch {
      port = DEFAULT_PORT;
    }
  }
  const host = opts.host ?? DEFAULT_HOST;

  const srv = http.createServer(requestHandler);
  server = srv;

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server = null;
      reject(err);
    };
    srv.once('error', onError);
    srv.listen(port, host, () => {
      srv.removeListener('error', onError);
      const addr = srv.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : (port as number);
      log.info('Portal API started', { host, port: boundPort });
      resolve({ port: boundPort });
    });
  });
}

/** Stop the portal API server. */
export async function stopPortalApi(): Promise<void> {
  if (server) {
    const srv = server;
    server = null;
    // End all live SSE streams first — otherwise server.close() waits forever
    // on the long-lived connections.
    stopBroadcaster();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    log.info('Portal API stopped');
  }
}
