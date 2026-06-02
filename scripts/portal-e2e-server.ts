#!/usr/bin/env tsx
/**
 * scripts/portal-e2e-server.ts — boots the REAL native-http portal API against
 * an in-memory, deterministically-seeded DB for the frontend Playwright E2E
 * harness (Sub-milestone 6.0b). No Docker, no LLM — fully free + deterministic,
 * so it runs in hosted CI on every push.
 *
 * Playwright's `webServer` launches this; it seeds the public read-model tables
 * + system_modes, starts the API on PORTAL_E2E_PORT (default 3099), and stays
 * up until SIGTERM/SIGINT.
 *
 * The seeded values are intentionally distinctive (live_mode=true) so an E2E
 * assertion proves the page rendered DB-backed data rather than the API's
 * empty-state defaults.
 */
import { closeDb, getDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { startPortalApi, stopPortalApi } from '../src/modules/portal/api.js';

const PORT = Number(process.env.PORTAL_E2E_PORT ?? 3099);

function seedMode(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO system_modes (key, value, changed_at) VALUES (?, ?, '2026-06-02T00:00:00Z')`)
    .run(key, value);
}

async function main(): Promise<void> {
  const db = initTestDb();
  runMigrations(db);

  seedMode('live_mode', 'true');
  seedMode('pause_state', 'active');

  const { port } = await startPortalApi({ host: '127.0.0.1', port: PORT });
  // eslint-disable-next-line no-console
  console.log(`[portal-e2e] listening on http://127.0.0.1:${port}`);

  const shutdown = async (): Promise<void> => {
    await stopPortalApi();
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
