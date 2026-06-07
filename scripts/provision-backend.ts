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
import { ensureContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { OWNER_DISALLOWED_TOOLS } from '../src/modules/career-pilot/owner-disallowed-tools.js';
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
  let ag = getAgentGroupByFolder(OWNER_FOLDER);
  if (ag) {
    initGroupFilesystem(ag); // idempotent; reconciles the persona files
    console.log(`  owner agent group exists: ${ag.id} (${OWNER_FOLDER})`);
  } else {
    createAgentGroup({
      id: genId('ag'),
      name: OWNER_AGENT_NAME,
      folder: OWNER_FOLDER,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    ag = getAgentGroupByFolder(OWNER_FOLDER)!;
    initGroupFilesystem(ag);
    console.log(`  created owner agent group: ${ag.id} (${OWNER_FOLDER})`);
  }
  // Owner tool-palette trim (§24.49d). Always reconcile so re-runs pick up edits
  // to OWNER_DISALLOWED_TOOLS (mirrors the sandbox's Layer-1 disallow reconcile).
  ensureContainerConfig(ag.id);
  updateContainerConfigJson(ag.id, 'disallowed_tools', OWNER_DISALLOWED_TOOLS);
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

  // Portal API port via the `preferences` config tier. The host reads it with
  // getConfig('portal_api_port'), whose env tier (process.env.PORTAL_API_PORT)
  // is empty under systemd — NanoClaw never loads .env into process.env — so the
  // preferences table is the durable, getConfig-native way to pin a per-env port
  // (dev 3002) on the shared VM. CP_PORTAL_API_PORT is exported by bootstrap-vm.sh.
  const portalPort = process.env.CP_PORTAL_API_PORT;
  if (portalPort && /^\d+$/.test(portalPort)) {
    db.prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES ('portal_api_port', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(portalPort, new Date().toISOString());
    console.log(`  set preferences.portal_api_port = ${portalPort}`);
  }

  // Dev cost caps — tighten the daily LLM budgets below the shared defaults
  // (config/defaults.json: owner 5 / sandbox 5) for the unattended dev closed
  // loop, so a runaway (e.g. a recruiter-sim bug — 9.3) is bounded. Seeded only
  // when NOT production, and only if ABSENT (ON CONFLICT DO NOTHING) so a runtime
  // tune (Telegram /set, or a manual preferences edit) is never clobbered by a
  // later deploy — and reset:dev preserves preferences, so the cap survives a
  // reset too. Prod (9.4) keeps the defaults.json values. 9.3 may tune these.
  if (env !== 'production') {
    const devCaps: Record<string, string> = {
      owner_daily_llm_budget_usd: '3',
      sandbox_daily_global_budget_usd: '2',
    };
    const now = new Date().toISOString();
    const seedCap = db.prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`,
    );
    for (const [k, v] of Object.entries(devCaps)) {
      const res = seedCap.run(k, v, now);
      console.log(`  dev cost cap ${k} = ${v}${res.changes ? '' : ' (already set — preserved)'}`);
    }
  }

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
