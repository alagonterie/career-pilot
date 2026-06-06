#!/usr/bin/env tsx
/**
 * scripts/portal-dev-server.ts — the dev fixture/demo data harness
 * (Sub-milestone 6.3, STRATEGY §24.26). The dev-facing analog of the E2E
 * server: it boots the REAL portal API against an in-memory DB seeded with a
 * fat, realistic dataset, runs a synthetic activity generator on a timer (so
 * the SSE tail streams continuous activity), and spawns `vite dev` pointed at
 * it — one command (`pnpm dev:mock`) for a live, animating local portal.
 *
 * MOCK MODE — every surface is faked, transparently: the audit/funnel/simulator
 * data is seeded (the telemetry panels read the seeded turn rows directly —
 * §24.47); the `docker ps` container count is faked through the env-gated
 * PORTAL_MOCK_CONTAINERS seam so every UI element renders populated. This is a
 * DEV TOOL, never the deployed site.
 *
 * Tunables (env, with defaults): PORTAL_MOCK_API_PORT=3010,
 * PORTAL_MOCK_FRONTEND_PORT=3000, PORTAL_MOCK_EVENT_MS=4000.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { closeDb, getDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  insertSyntheticEvent,
  maybeAdvanceFunnel,
  mockContainerCount,
  newGeneratorState,
  seedDeterministicSimulatorRun,
  seedRichFixture,
} from '../src/modules/portal/dev/fixtures.js';
import { startPortalApi, stopPortalApi } from '../src/modules/portal/api.js';

const API_PORT = Number(process.env.PORTAL_MOCK_API_PORT ?? 3010);
const FRONTEND_PORT = Number(process.env.PORTAL_MOCK_FRONTEND_PORT ?? 3000);
const EVENT_MS = Number(process.env.PORTAL_MOCK_EVENT_MS ?? 4000);

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const frontendDir = path.join(repoRoot, 'frontend');

async function main(): Promise<void> {
  // Set the env-gated dev seams BEFORE startPortalApi so the handlers see them.
  // (Telemetry panels read the seeded turn rows directly — no Portkey seam, §24.47.)
  process.env.PORTAL_MOCK_CONTAINERS = String(mockContainerCount());
  // §24.31: scripted, container-free simulator runs (no LLM/Docker locally).
  process.env.PORTAL_MOCK_SIMULATOR = process.env.PORTAL_MOCK_SIMULATOR ?? '1';
  // §24.36 36.1: honor the `?__state=loading|empty|error` override so the dev
  // state-switcher can drive every async surface's edge states live. Mock-only.
  process.env.PORTAL_MOCK_STATE_SEAM = process.env.PORTAL_MOCK_STATE_SEAM ?? '1';

  const db = initTestDb();
  runMigrations(db);
  seedRichFixture(db);
  seedDeterministicSimulatorRun(db);

  const { port } = await startPortalApi({ host: '127.0.0.1', port: API_PORT });
  const apiBase = `http://127.0.0.1:${port}`;

  // Synthetic activity generator → the SSE tail streams it live.
  const state = newGeneratorState();
  const generator = setInterval(() => {
    try {
      insertSyntheticEvent(getDb(), state);
      maybeAdvanceFunnel(getDb(), state);
    } catch (err) {
      console.error('[dev:mock] generator tick failed', err);
    }
  }, Math.max(250, EVENT_MS));
  generator.unref();

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  ┌────────────────────────────────────────────────────────────┐',
      '  │  MOCK MODE — synthetic data (dev fixture/demo harness)       │',
      '  │  Every surface is faked, including Portkey + container count.│',
      '  │  This is a DEV TOOL, never the deployed site.                │',
      '  └────────────────────────────────────────────────────────────┘',
      `  portal API : ${apiBase}`,
      `  new event  : every ${Math.max(250, EVENT_MS)}ms`,
      `  frontend   : starting vite dev on :${FRONTEND_PORT} (VITE_API_BASE → ${apiBase})`,
      '',
    ].join('\n'),
  );

  // Spawn `vite dev` (frontend), pointed at the mock API. shell:true so the
  // pnpm shim resolves on Windows + POSIX.
  const vite = spawn('pnpm', ['--filter', '@career-pilot/frontend', 'dev', '--', '--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: frontendDir,
    env: { ...process.env, VITE_API_BASE: apiBase },
    stdio: 'inherit',
    shell: true,
  });

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(generator);
    if (!vite.killed) vite.kill();
    await stopPortalApi();
    closeDb();
    process.exit(code);
  };

  vite.on('exit', (code) => void shutdown(code ?? 0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
