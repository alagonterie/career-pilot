/**
 * scripts/backfill-apply-links.ts — re-derive apply links for existing leads
 * (STRATEGY.md §24.190).
 *
 * Before §24.190 the google_jobs adapter stored `apply_options[0]` — Google's own
 * ordering, not a directness ordering — so leads routinely carried an
 * aggregator's URL even when a direct company/ATS link sat one slot further down
 * the same array.
 *
 * That array is already on disk: `raw_payload.apply_options` is persisted for
 * every google_jobs lead. So this repairs history with **zero SerpApi spend and
 * no re-scrape** — it re-ranks what we already have and writes back the better
 * link plus its `apply_link_kind`.
 *
 * Non-google_jobs leads are skipped: greenhouse/lever adapters link to the
 * employer's own board by construction, so there is nothing to improve.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-apply-links.ts            # dry run (default)
 *   pnpm exec tsx scripts/backfill-apply-links.ts --apply    # write
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { pickApplyLink, type ApplyLinkKind } from '../src/modules/career-pilot/apply-link.js';

const APPLY = process.argv.includes('--apply');

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

interface Row {
  id: string;
  company: string;
  source_url: string;
  apply_url: string | null;
  apply_link_kind: string | null;
  raw_payload: string | null;
}

const rows = getDb()
  .prepare(
    `SELECT id, company, source_url, apply_url, apply_link_kind, raw_payload
       FROM job_leads
      WHERE source = 'google_jobs'`,
  )
  .all() as Row[];

console.log(`${rows.length} google_jobs lead(s) to examine.${APPLY ? '' : '  (dry run — pass --apply to write)'}\n`);

const update = getDb().prepare(`UPDATE job_leads SET apply_url = @apply_url, apply_link_kind = @kind WHERE id = @id`);

let improved = 0;
let classifiedOnly = 0;
let unchanged = 0;
const byKind: Record<string, number> = {};

for (const r of rows) {
  let applyOptions: { title?: string; link?: string }[] = [];
  let fallback: string | null = null;
  try {
    const raw = r.raw_payload ? (JSON.parse(r.raw_payload) as Record<string, unknown>) : {};
    if (Array.isArray(raw.apply_options)) applyOptions = raw.apply_options as { title?: string; link?: string }[];
    fallback = (raw.source_link as string | null) ?? (raw.share_link as string | null) ?? null;
  } catch {
    // A lead with an unreadable payload keeps whatever it has — never worsen a row.
  }

  const picked = pickApplyLink(applyOptions, r.company, fallback ?? r.source_url);
  const nextUrl = picked.url ?? r.apply_url;
  const nextKind: ApplyLinkKind = picked.kind;
  byKind[nextKind] = (byKind[nextKind] ?? 0) + 1;

  const urlChanged = nextUrl !== r.apply_url;
  const kindChanged = nextKind !== r.apply_link_kind;
  if (!urlChanged && !kindChanged) {
    unchanged += 1;
    continue;
  }
  if (urlChanged) {
    improved += 1;
    console.log(`${r.company} — ${r.id}`);
    console.log(`   was: ${r.apply_url ?? '(none)'}`);
    console.log(`   now: ${nextUrl}   [${nextKind}]`);
  } else {
    classifiedOnly += 1;
  }
  if (APPLY) update.run({ id: r.id, apply_url: nextUrl, kind: nextKind });
}

console.log(`\nLink improved: ${improved}`);
console.log(`Classified only (link already best): ${classifiedOnly}`);
console.log(`Unchanged: ${unchanged}`);
console.log(`Link kinds: ${JSON.stringify(byKind)}`);
if (byKind.aggregator) {
  console.log(
    `\n${byKind.aggregator} lead(s) have NO direct link in their stored options — those are the ones whose\n` +
      `company attribution is also unverified. /admin flags them; re-scraping won't help (the\n` +
      `posting only reached Google through a reposter).`,
  );
}
console.log(APPLY ? '\nApplied.' : '\nDry run — nothing written. Re-run with --apply.');
