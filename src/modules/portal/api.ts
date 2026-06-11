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
 *   GET /api/funnel          public_funnel_view + read-time-computed days + stage_counts
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

import { getDb } from '../../db/connection.js';
import { countRunningContainers } from '../../container-runtime.js';
import { getActiveSessions, getRunningSessions } from '../../db/sessions.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { loadState, simStatePath } from '../career-pilot/recruiter-sim/runner.js';

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
import { getTelemetry } from './portkey-analytics.js';
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

interface FunnelViewRow {
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
  kits_json: string | null;
}

/** Parse a public_funnel_view kits_json column into the API's interview_kits array. */
function parseKitsJson(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function handleFunnel(res: http.ServerResponse, cors: Record<string, string>): void {
  const rows = getDb()
    .prepare(
      `SELECT application_id, application_ref, public_state, role_title, status, stage,
              applied_at, stage_entered_at, last_activity_at, win_confidence,
              win_confidence_rationale, published_learning, kits_json
         FROM public_funnel_view`,
    )
    .all() as FunnelViewRow[];

  const now = Date.now();
  const applications = rows.map(({ kits_json, ...r }) => ({
    ...r,
    days_in_stage: daysSince(r.stage_entered_at, now),
    days_in_pipeline: daysSince(r.applied_at, now),
    // §24.65: per-kit existence metadata for the drawer's "Interview prep"
    // section — enums + timestamps only; kit CONTENT rides /api/kit, never
    // this polled payload.
    interview_kits: parseKitsJson(kits_json),
  }));

  const stage_counts: Record<string, number> = {};
  for (const r of rows) {
    stage_counts[r.stage] = (stage_counts[r.stage] ?? 0) + 1;
  }

  json(res, 200, { applications, stage_counts }, cors);
}

/**
 * §24.65: one kit's public projection for the /kit dossier page.
 * `?app=«application_ref»&round=«ROUND»` — the ref is the public key the
 * frontend holds (same first-match resolution rule as the /pipeline drawer;
 * the two-public-apps-one-company collision is the accepted §24.62 behavior).
 * Reads ONLY public tables (public_funnel_view → public_kit_view); sealed
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
         FROM public_funnel_view WHERE application_ref = ? LIMIT 1`,
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
  try {
    capacityMax = getConfig<number>(getDb(), 'container_max_concurrent', 4);
    memoryMbEach = getConfig<number>(getDb(), 'container_memory_mb', 512);
  } catch {
    // defaults
  }

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
  const result = startSimulatorRun(input);
  if (result.ok) {
    json(res, 200, { simulation_id: result.simulation_id }, cors);
    return;
  }
  const status = result.error?.code === 'BAD_ARGS' ? 400 : 503;
  json(res, status, { error: result.error?.code ?? 'error', message: result.error?.message }, cors);
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
  json(res, 200, row, cors);
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
    case '/api/funnel':
      return { applications: [], stage_counts: {} };
    case '/api/activity':
      return { events: [], next_since: 0 };
    case '/api/architecture':
      return {
        sessions: { active: 0, running: 0 },
        containers: { running: 0, capacity_max: 0, memory_mb_each: 0, runtime: 'up' },
        backend: 'online',
      };
    case '/api/system-status':
      return { live_mode: false, pause_state: 'active', pause_reason: null, backend: 'online' };
    case '/api/telemetry':
      return {
        local: {
          simulator_runs_total: 0,
          activity_events_total: 0,
          activity_events_24h: 0,
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

    const auth = checkAuth(req);
    if (!auth.ok) {
      json(res, 401, { error: 'unauthorized', reason: auth.reason ?? null }, cors);
      return;
    }

    // Mock-only async-state override (§24.36 36.1) — dev/E2E only; inert in prod.
    const forced = method === 'GET' ? parseForcedState(url) : null;
    if (forced) return applyForcedState(forced, path, req, res, cors);

    if (method === 'GET' && path === '/api/funnel') return handleFunnel(res, cors);
    if (method === 'GET' && path === '/api/kit') return handleKit(url, res, cors);
    if (method === 'GET' && path === '/api/activity/stream') return handleActivityStream(req, res, url, cors);
    if (method === 'GET' && path === '/api/activity') return handleActivity(url, res, cors);
    if (method === 'GET' && path === '/api/telemetry') return await handleTelemetry(res, cors);
    if (method === 'GET' && path === '/api/architecture') return handleArchitecture(res, cors);
    if (method === 'GET' && path === '/api/system-status') return handleSystemStatus(res, cors);
    if (method === 'POST' && path === '/api/contact') return await handleContact(req, res, cors);
    if (method === 'POST' && path === '/api/sanitize-demo') return await handleSanitizeDemo(req, res, cors);
    if (method === 'POST' && path === '/api/simulator') return await handleSimulatorStart(req, res, cors);
    if (method === 'GET' && path === '/api/simulator/recent') return handleSimulatorRecent(res, cors);
    if (method === 'GET' && path.startsWith('/api/simulator/results/')) {
      const id = path.slice('/api/simulator/results/'.length);
      if (id.length > 0) return handleSimulatorResult(res, id, cors);
    }
    if (method === 'GET' && path.startsWith('/api/simulator/') && path.endsWith('/stream')) {
      const runId = path.slice('/api/simulator/'.length, -'/stream'.length);
      if (runId.length > 0) return handleSimulatorStream(req, res, runId, cors);
    }

    // Dev inspector (§24.42b): the whole `/api/dev/*` prefix is invisible
    // (404) unless this is the dev stack — the non-negotiable PII guard.
    if (path.startsWith('/api/dev/')) {
      if (!isDevEnv()) return json(res, 404, { error: 'not_found', path }, cors);
      if (method === 'GET' && path === '/api/dev/state') return handleDevState(res, cors);
      if (method === 'GET' && path === '/api/dev/knobs') return handleDevKnobs(res, cors);
      if (method === 'POST' && path === '/api/dev/knobs') return await handleDevKnobsWrite(req, res, cors);
      if (method === 'GET' && path === '/api/dev/persona') return handleDevPersona(res, cors);
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
