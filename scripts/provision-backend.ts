#!/usr/bin/env tsx
/**
 * scripts/provision-backend.ts — non-interactive backend DB provisioning for a
 * DEPLOYED career-pilot stack (dev now; the prod cutover opts in at 9.4).
 *
 * The real, non-stub counterpart to the data-tier steps that
 * scripts/setup-local.ts only sketches and scripts/test/setup-test.ts bundles
 * with test-only wiring: apply migrations and register our two agent groups —
 * the `career-pilot` owner group and the `career-pilot-sandbox` public group —
 * with their on-disk filesystem (persona seed) + portal channel wiring, so the
 * host comes up serving the portal /api/* surface and the simulator. Idempotent
 * — re-run on every deploy.
 *
 * What it deliberately does NOT do:
 *   - Channel pairing. Wiring the owner's Telegram account to the career-pilot
 *     group needs the operator's platform user-id, captured by the one-time
 *     interactive pairing step — a headless deploy can't mint it.
 *   - Credentials. The OneCLI vault + .env are scripts/bootstrap-vm.sh's job.
 *   - LIVE_MODE. The host boots in the system-default shadow mode. Going live
 *     is gated on the recipient allow-list (a later sub-milestone); flipping it
 *     before that guard exists would invert the very rationale that makes
 *     dev-live safe, so it is NOT done here.
 *
 * Usage:
 *   pnpm exec tsx scripts/provision-backend.ts [--allow-production]
 *
 * Refuses to run when ENVIRONMENT=production unless --allow-production is
 * passed (the Phase 9.4 prod cutover opts in explicitly), mirroring the
 * production guards in setup-test.ts / reset-dev.ts.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { ensureSandboxGroup, SANDBOX_FOLDER } from './init-sandbox-group.js';
import type { AgentGroup } from '../src/types.js';

const OWNER_FOLDER = 'career-pilot';
const OWNER_AGENT_NAME = 'Career Pilot';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create-or-reconcile the owner agent group + its filesystem. Mirrors
 * setup-test.ts:ensureAgentGroup, minus the cli/local wiring (the deployed
 * owner channel is Telegram, paired separately by a human).
 */
function ensureOwnerGroup(): AgentGroup {
  const existing = getAgentGroupByFolder(OWNER_FOLDER);
  if (existing) {
    initGroupFilesystem(existing); // idempotent; reconciles the persona files
    console.log(`  owner agent group exists: ${existing.id} (${OWNER_FOLDER})`);
    return existing;
  }
  createAgentGroup({
    id: genId('ag'),
    name: OWNER_AGENT_NAME,
    folder: OWNER_FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  const ag = getAgentGroupByFolder(OWNER_FOLDER)!;
  initGroupFilesystem(ag);
  console.log(`  created owner agent group: ${ag.id} (${OWNER_FOLDER})`);
  return ag;
}

function main(): void {
  const allowProduction = process.argv.includes('--allow-production');
  const env = process.env.ENVIRONMENT ?? '';
  if (env === 'production' && !allowProduction) {
    console.error('provision-backend: ENVIRONMENT=production — refusing without --allow-production.');
    process.exit(2);
  }

  console.log(`Provisioning career-pilot backend (ENVIRONMENT=${env || 'unset'})`);

  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db); // idempotent
  console.log('  migrations applied');

  const owner = ensureOwnerGroup();
  const sandbox = ensureSandboxGroup();
  console.log(`  sandbox group ready: ${sandbox.id} (${SANDBOX_FOLDER}) + portal/sandbox wiring`);

  closeDb();

  console.log('');
  console.log('Backend provisioned. Groups registered:');
  console.log(`  owner:   ${owner.name} [${owner.id}] @ groups/${OWNER_FOLDER}`);
  console.log(`  sandbox: ${sandbox.name} [${sandbox.id}] @ groups/${SANDBOX_FOLDER}`);
  console.log('');
  console.log('One-time human steps remain (no headless path by design):');
  console.log('  · Pair the owner Telegram account to the career-pilot group.');
  console.log('  · Connect Gmail OAuth via the gated OneCLI UI (dev scope).');
}

main();
