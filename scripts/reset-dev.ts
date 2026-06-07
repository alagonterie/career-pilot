#!/usr/bin/env tsx
/**
 * scripts/reset-dev.ts — reset the career-pilot DEV stack to a clean APP-DATA
 * state for re-testing flows, WITHOUT forcing any re-auth. See STRATEGY.md
 * §24.41 + §16.5 + RECOVERY.md §7.
 *
 * SOFT reset: truncate the career-pilot DOMAIN tables + clear conversation
 * sessions, but PRESERVE everything expensive or impossible to re-establish
 * headlessly:
 *   - OneCLI vault (Gmail/Calendar OAuth) — lives in the onecli_pgdata docker
 *     volume, untouched here. NEVER `docker compose down -v` it.
 *   - Telegram owner-pairing + permissions — the NanoClaw core tables (users /
 *     user_roles / user_dms / agent_groups / agent_group_members /
 *     messaging_groups / messaging_group_agents / chat_sdk_* / container_configs).
 *   - Config + persona — preferences, system_modes, candidate_profile.
 *   - .env, installed deps, the agent container image.
 *
 * This deliberately reverses the Phase-0 stub's "clear the vault + force re-pair"
 * intent: §24.41 makes a reset cheap to run repeatedly (drive a funnel, reset,
 * repeat) without the painful OAuth/pairing re-do each time.
 *
 * Safety-guarded against production. Triggered two ways (§24.41):
 *   - CI: `gh workflow run deploy-backend.yml -f reset=true` (the deploy stops
 *     the host unit, runs this, then re-provisions + restarts).
 *   - Direct over Tailscale SSH on the VM: stop the host unit, run
 *     `pnpm exec tsx scripts/reset-dev.ts`, restart the unit.
 *
 * Re-migration on the next provision is a no-op (schema unchanged); the owner +
 * sandbox groups are reconciled idempotently by provision-backend.ts.
 *
 * Usage:
 *   pnpm exec tsx scripts/reset-dev.ts [--allow-production] [--dry-run]
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
// The career-pilot DOMAIN tables this reset clears — the SINGLE source of truth,
// shared with the dev inspector's scoped `/api/dev/reset` (§24.48) so the two
// never drift. It's an explicit ALLOW-LIST: never the NanoClaw core
// (permissions/messaging = pairing), config (preferences/system_modes), the
// persona (candidate_profile), or schema_version. New domain table → add it in
// src/modules/portal/dev/app-data-reset.ts. (`sessions` is last; the JSONL
// transcripts are cleared below.)
import { APP_DATA_TABLES } from '../src/modules/portal/dev/app-data-reset.js';

function main(): void {
  const allowProduction = process.argv.includes('--allow-production');
  const dryRun = process.argv.includes('--dry-run');
  const env = process.env.ENVIRONMENT ?? '';
  if (env === 'production' && !allowProduction) {
    console.error('reset-dev: ENVIRONMENT=production — refusing without --allow-production.');
    process.exit(2);
  }

  console.log(`reset-dev: SOFT reset (ENVIRONMENT=${env || 'unset'}${dryRun ? ', DRY-RUN' : ''})`);
  console.log(
    '  preserving: OneCLI vault, Telegram pairing, permissions, preferences, system_modes, candidate_profile, .env',
  );

  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);

  // FKs OFF so a full multi-table wipe never trips a parent/child ordering
  // constraint (a no-op inside a transaction, so set it here, before the tx).
  db.pragma('foreign_keys = OFF');

  // Only target tables that actually exist (defensive across schema drift).
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
  );

  let totalRows = 0;
  const wipe = db.transaction(() => {
    for (const t of APP_DATA_TABLES) {
      if (!present.has(t)) {
        console.log(`  skip ${t} (no such table)`);
        continue;
      }
      const n = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
      totalRows += n;
      if (!dryRun) db.prepare(`DELETE FROM ${t}`).run();
      console.log(`  ${dryRun ? 'would clear' : 'cleared'} ${t}: ${n} rows`);
    }
  });
  wipe();

  closeDb();

  // Clear conversation transcripts (data/v2-sessions/*). The directory stays;
  // only its contents go. Tolerate absence.
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  let sessionEntries = 0;
  if (fs.existsSync(sessionsDir)) {
    for (const entry of fs.readdirSync(sessionsDir)) {
      sessionEntries++;
      if (!dryRun) fs.rmSync(path.join(sessionsDir, entry), { recursive: true, force: true });
    }
  }
  console.log(`  ${dryRun ? 'would clear' : 'cleared'} ${sessionEntries} session transcript(s) under ${sessionsDir}`);

  console.log('');
  console.log(
    `reset-dev: done — ${
      dryRun ? '(dry-run, no changes)' : `cleared ${totalRows} app-data rows + ${sessionEntries} session transcripts`
    }.`,
  );
  console.log('  Restart the host unit to serve the clean slate (CI bootstrap does this automatically).');
}

try {
  main();
} catch (err) {
  console.error('reset-dev: failed —', err);
  process.exit(1);
}
