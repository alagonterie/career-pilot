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
 * Later sub-milestones add: SSE (/api/activity/stream, 5.2), telemetry +
 * architecture (5.3), simulator streams (5.5). See STRATEGY.md §10 + §24.15.
 */
import http from 'http';

import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }
  return {};
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string>,
): void {
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

// ── route handlers ───────────────────────────────────────────────────────

interface FunnelViewRow {
  application_ref: string;
  public_state: string;
  role_title: string | null;
  status: string;
  stage: string;
  applied_at: string | null;
  stage_entered_at: string | null;
  last_activity_at: string | null;
  win_confidence: number | null;
  published_learning: string | null;
}

function handleFunnel(res: http.ServerResponse, cors: Record<string, string>): void {
  const rows = getDb()
    .prepare(
      `SELECT application_ref, public_state, role_title, status, stage,
              applied_at, stage_entered_at, last_activity_at, win_confidence, published_learning
         FROM public_funnel_view`,
    )
    .all() as FunnelViewRow[];

  const now = Date.now();
  const applications = rows.map((r) => ({
    ...r,
    days_in_stage: daysSince(r.stage_entered_at, now),
    days_in_pipeline: daysSince(r.applied_at, now),
  }));

  const stage_counts: Record<string, number> = {};
  for (const r of rows) {
    stage_counts[r.stage] = (stage_counts[r.stage] ?? 0) + 1;
  }

  json(res, 200, { applications, stage_counts }, cors);
}

function handleActivity(
  url: URL,
  res: http.ServerResponse,
  cors: Record<string, string>,
): void {
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? parseInt(sinceRaw, 10) : 0;
  const limitRaw = url.searchParams.get('limit');
  let limit =
    limitRaw != null && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : ACTIVITY_DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), ACTIVITY_MAX_LIMIT);

  const events = getDb()
    .prepare(
      `SELECT seq, ts, category, agent_name, proactive, application_ref, model_used,
              tokens, cost_cents, cache_hit, latency_ms, summary
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

// ── request router ───────────────────────────────────────────────────────

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
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

    if (method === 'GET' && path === '/api/funnel') return handleFunnel(res, cors);
    if (method === 'GET' && path === '/api/activity') return handleActivity(url, res, cors);
    if (method === 'GET' && path === '/api/system-status') return handleSystemStatus(res, cors);

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
    const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port ?? DEFAULT_PORT;
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
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    log.info('Portal API stopped');
  }
}
