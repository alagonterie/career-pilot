#!/usr/bin/env tsx
/**
 * scripts/portal-e2e-server.ts — boots the REAL native-http portal API against
 * an in-memory, deterministically-seeded DB for the frontend Playwright E2E
 * harness (Sub-milestones 6.0b / 6.1). No Docker, no LLM — fully free +
 * deterministic, so it runs in hosted CI on every push.
 *
 * Playwright's `webServer` launches this; it seeds the deterministic backlog +
 * pipeline rows (shared from src/modules/portal/dev/fixtures.ts — §24.26/§24.27),
 * starts the API
 * on PORTAL_E2E_PORT (default 3099), starts a tiny test-only CONTROL server on
 * PORTAL_E2E_CONTROL_PORT (default 3098), and stays up until SIGTERM/SIGINT.
 *
 * The control server is harness-only — it lets the live-push E2E insert an
 * audit row after page load so the test can prove the SSE tail delivers a NEW
 * event through the fetch-reader. Production `src/modules/portal/api.ts` has no
 * such endpoint. This server does NOT run the synthetic generator — that's the
 * dev server (scripts/portal-dev-server.ts); here the data stays fixed so the
 * visual snapshots are stable.
 *
 * The one mock-env it does set is PORTAL_MOCK_CONTAINERS (§24.28): the
 * /api/architecture container count comes from a `docker ps` call with no DB
 * source, so a fixed value is the only way to make that node's status badge
 * deterministic without Docker (which CI doesn't have). Everything else the
 * architecture page reads (sessions, system modes) is seeded in the DB.
 */
import http from 'http';

import { closeDb, getDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  insertAuditRow,
  nextAuditSeq,
  seedCandidateProfileIdentity,
  seedDeterministicBacklog,
  seedDeterministicPipeline,
  seedDeterministicKits,
  seedDeterministicSimulatorRun,
  seedRequestTelemetry,
  seedSessions,
  type AuditSeed,
} from '../src/modules/portal/dev/fixtures.js';
import { _setLastSweepAtForTesting } from '../src/host-sweep.js';
import { startPortalApi, stopPortalApi } from '../src/modules/portal/api.js';

const PORT = Number(process.env.PORTAL_E2E_PORT ?? 3099);
const CONTROL_PORT = Number(process.env.PORTAL_E2E_CONTROL_PORT ?? 3098);

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
          const seq = nextAuditSeq(getDb());
          insertAuditRow(getDb(), {
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
  // Fixed container count (no DB source — see file header) so /api/architecture
  // is deterministic without Docker. Set before the API starts serving.
  process.env.PORTAL_MOCK_CONTAINERS = process.env.PORTAL_MOCK_CONTAINERS ?? '2';
  // §24.31: enable the scripted, container-free simulator seam so the /simulator
  // happy path (run → live stream → results) is exercised end-to-end with no
  // Docker/LLM. Without it, POST /api/simulator would 503 (no adapter) — that
  // unavailable branch is unit-tested instead.
  process.env.PORTAL_MOCK_SIMULATOR = process.env.PORTAL_MOCK_SIMULATOR ?? '1';
  // §24.36 36.1: honor the `?__state=loading|empty|error` override so the
  // loading/empty/error UIs are reachable + snapshottable in the E2E (the seeded
  // DB is otherwise always instant + populated). Mock-only — prod never sets it.
  process.env.PORTAL_MOCK_STATE_SEAM = process.env.PORTAL_MOCK_STATE_SEAM ?? '1';

  const db = initTestDb();
  runMigrations(db);

  seedDeterministicBacklog(db);
  seedDeterministicPipeline(db);
  await seedDeterministicKits(db);
  seedDeterministicSimulatorRun(db);
  seedSessions(db);
  seedRequestTelemetry(db);
  seedCandidateProfileIdentity(db);
  // §24.80: the host sweep loop isn't running in this API-only harness, so stamp
  // a recent tick → the Cron-sweep node reads healthy (matching the fixtures'
  // "arch nodes read healthy" intent), not idle.
  _setLastSweepAtForTesting(Date.now());

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
