#!/usr/bin/env tsx
/**
 * scripts/portal-e2e-server.ts — boots the REAL native-http portal API against
 * an in-memory, deterministically-seeded DB for the frontend Playwright E2E
 * harness (Sub-milestones 6.0b / 6.1). No Docker, no LLM — fully free +
 * deterministic, so it runs in hosted CI on every push.
 *
 * Playwright's `webServer` launches this; it seeds the public read-model tables
 * + system_modes + a few public_audit_trail rows (so the live ticker is
 * populated on load), starts the API on PORTAL_E2E_PORT (default 3099), starts
 * a tiny test-only CONTROL server on PORTAL_E2E_CONTROL_PORT (default 3098),
 * and stays up until SIGTERM/SIGINT.
 *
 * The control server is harness-only — it lets the live-push E2E insert an
 * audit row after page load so the test can prove the SSE tail delivers a NEW
 * event through the fetch-reader. Production `src/modules/portal/api.ts` has no
 * such endpoint.
 *
 * Seeded values are intentionally distinctive (live_mode=true; a proactive
 * subagent_progress row with agent_name + model) so an E2E assertion proves the
 * page rendered DB-backed data rather than the API's empty-state defaults.
 */
import http from 'http';

import { closeDb, getDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { startPortalApi, stopPortalApi } from '../src/modules/portal/api.js';

const PORT = Number(process.env.PORTAL_E2E_PORT ?? 3099);
const CONTROL_PORT = Number(process.env.PORTAL_E2E_CONTROL_PORT ?? 3098);

function seedMode(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO system_modes (key, value, changed_at) VALUES (?, ?, '2026-06-02T00:00:00Z')`)
    .run(key, value);
}

interface AuditSeed {
  seq: number;
  ts: string;
  category: string;
  agent_name?: string | null;
  proactive?: 0 | 1;
  application_ref?: string | null;
  model_used?: string | null;
  cache_hit?: 0 | 1;
  summary: string;
}

function insertAudit(row: AuditSeed): void {
  getDb()
    .prepare(
      `INSERT INTO public_audit_trail
         (id, seq, ts, category, agent_name, proactive, application_ref, model_used, cache_hit, summary)
       VALUES (@id, @seq, @ts, @category, @agent_name, @proactive, @application_ref, @model_used, @cache_hit, @summary)`,
    )
    .run({
      id: `e2e-${row.seq}`,
      seq: row.seq,
      ts: row.ts,
      category: row.category,
      agent_name: row.agent_name ?? null,
      proactive: row.proactive ?? 0,
      application_ref: row.application_ref ?? null,
      model_used: row.model_used ?? null,
      cache_hit: row.cache_hit ?? 0,
      summary: row.summary,
    });
}

/** Test-only control plane: POST /audit inserts a row (seq = MAX+1) so the
 * 1s SSE tail picks it up and pushes it to connected clients. */
function startControlServer(): http.Server {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/audit') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const p = body ? (JSON.parse(body) as Partial<AuditSeed>) : {};
          const seq =
            (getDb().prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM public_audit_trail').get() as { s: number }).s;
          insertAudit({
            seq,
            ts: new Date().toISOString(),
            category: p.category ?? 'subagent_progress',
            agent_name: p.agent_name ?? null,
            proactive: p.proactive ?? 0,
            application_ref: p.application_ref ?? null,
            model_used: p.model_used ?? null,
            cache_hit: p.cache_hit ?? 0,
            summary: p.summary ?? 'live event',
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ seq }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  srv.listen(CONTROL_PORT, '127.0.0.1');
  return srv;
}

async function main(): Promise<void> {
  const db = initTestDb();
  runMigrations(db);

  seedMode('live_mode', 'true');
  seedMode('pause_state', 'active');

  // A small, deterministic backlog (fixed ts → stable visual snapshot). Mixes a
  // proactive funnel row, a proactive subagent_progress row (agent_name + the
  // model/cache telemetry lanes), and a reactive funnel row.
  insertAudit({
    seq: 1,
    ts: '2026-06-02T16:30:00Z',
    category: 'funnel',
    proactive: 1,
    application_ref: 'fintech-a',
    summary: 'advanced to tech screen',
  });
  insertAudit({
    seq: 2,
    ts: '2026-06-02T16:35:00Z',
    category: 'subagent_progress',
    agent_name: 'research-company',
    proactive: 1,
    model_used: 'opus-4-7',
    cache_hit: 1,
    summary: 'mapped the engineering org',
  });
  insertAudit({
    seq: 3,
    ts: '2026-06-02T16:42:00Z',
    category: 'funnel',
    proactive: 0,
    application_ref: 'ai-infra-b',
    summary: 'logged a recruiter reply',
  });

  const { port } = await startPortalApi({ host: '127.0.0.1', port: PORT });
  const control = startControlServer();
  // eslint-disable-next-line no-console
  console.log(`[portal-e2e] api on http://127.0.0.1:${port}, control on http://127.0.0.1:${CONTROL_PORT}`);

  const shutdown = async (): Promise<void> => {
    await stopPortalApi();
    await new Promise<void>((resolve) => control.close(() => resolve()));
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
