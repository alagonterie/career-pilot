/**
 * scripts/backfill-lead-promotions.ts — one-time backfill for §24.175.
 *
 * The live `promoteLeadOnApplied` hook fires on an application's transition INTO a
 * submitted stage, so applications that were already `APPLIED`/beyond before the
 * hook shipped never got their originating lead linked. This walks every
 * already-submitted application and links the matching open, unlinked lead
 * (`application_id` + `status='applied'`), using the exact runtime match logic
 * (exact URL → company+title fallback → highest rules_score).
 *
 * Defaults to a DRY RUN (writes inside a transaction, then rolls back — an accurate
 * preview that simulates the sequential one-lead-per-app claiming). Pass `--apply`
 * to commit. Idempotent + safe to re-run. Host-side operator script (like
 * relabel-application.ts), opens its own connection; safe while the host is up.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-lead-promotions.ts            # dry run (preview)
 *   pnpm exec tsx scripts/backfill-lead-promotions.ts --apply    # commit
 *   pnpm exec tsx scripts/backfill-lead-promotions.ts --json
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { backfillLeadPromotions } from '../src/modules/career-pilot/lead-promotion.js';

const apply = process.argv.includes('--apply');
const asJson = process.argv.includes('--json');

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

db.exec('BEGIN');
let result: ReturnType<typeof backfillLeadPromotions>;
try {
  result = backfillLeadPromotions(db);
  db.exec(apply ? 'COMMIT' : 'ROLLBACK');
} catch (err) {
  db.exec('ROLLBACK');
  db.close();
  throw err;
}

if (asJson) {
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2));
} else {
  const byVia = result.promotions.reduce<Record<string, number>>((acc, p) => {
    acc[p.via] = (acc[p.via] ?? 0) + 1;
    return acc;
  }, {});
  console.log(apply ? 'APPLIED (changes committed).' : 'DRY RUN — no changes written. Pass --apply to commit.');
  console.log(
    `Scanned ${result.scanned} submitted application(s); ${apply ? 'linked' : 'would link'} ${result.promotions.length} lead(s).`,
  );
  if (result.promotions.length > 0) {
    console.log(
      `  by match: ${Object.entries(byVia)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
    for (const p of result.promotions) {
      console.log(`  app ${p.applicationId}  <-  lead ${p.leadId}  (${p.via})`);
    }
  }
}

db.close();
