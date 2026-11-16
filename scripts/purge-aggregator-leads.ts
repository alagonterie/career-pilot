/**
 * scripts/purge-aggregator-leads.ts — one-time purge of search-sourced leads whose
 * apply link the insert guard now refuses (STRATEGY.md §24.200 D3).
 *
 * The pool was ~80% aggregator reposts. §24.200 D1 stops new ones at the insert;
 * this clears the ones already stored. It is a RELEASE STEP: run it only AFTER
 * the D1 gate is deployed, or the next scrape re-adds what was purged.
 *
 * What it does, in order:
 *   1. Touches only `source='google_jobs'` rows (a manual or board lead is never
 *      examined).
 *   2. Re-derives each row's apply link + kind from its stored `raw_payload` first
 *      (the §24.190 logic, shared with backfill-apply-links.ts) — a row stored
 *      before the ranking existed may in fact have a direct link one slot down.
 *   3. Deletes rows whose re-derived kind is in `lead_reject_link_kinds`, writing
 *      an id-only tombstone (`reason='link:<kind>'`) for each, so the same posting
 *      only comes back if it is later found with a direct link.
 *   4. SKIPS, and reports by reason, any lead with an application, a tailored
 *      résumé (the delete would cascade it away), an email_events link (that FK
 *      has no delete action — the delete would throw), or a status the owner set
 *      deliberately (queued / reviewed).
 *
 * Dry-run by default — nothing is written without --apply (not even the
 * re-derived kinds).
 *
 * Usage:
 *   pnpm exec tsx scripts/purge-aggregator-leads.ts data/v2.db            # dry run
 *   pnpm exec tsx scripts/purge-aggregator-leads.ts data/v2.db --apply    # write
 *   pnpm exec tsx scripts/purge-aggregator-leads.ts data/v2.db --json     # machine-readable report
 */
import { basename } from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { hasTable } from '../src/db/connection.js';
import { getConfig } from '../src/get-config.js';
import { rederiveStoredApplyLink } from '../src/modules/career-pilot/apply-link.js';
import { writeTombstone } from '../src/modules/career-pilot/lead-guard.js';

export type PurgeSkipReason = 'application' | 'tailored_resume' | 'email_link' | 'owner_status';

/** Statuses the owner sets deliberately — a purge must not undo a decision. */
const OWNER_STATUSES = new Set(['queued', 'reviewed']);

export interface PurgeReport {
  apply: boolean;
  /** google_jobs rows examined. */
  examined: number;
  /** Rows whose re-derived link or kind differs from what is stored. */
  rederived_changed: number;
  /** Re-derived kind counts across all examined rows. */
  kinds: Record<string, number>;
  /** Rows whose kind the guard rejects (deleted + skipped). */
  rejected_kind: number;
  /** Rows deleted (with --apply) or that would be deleted (dry run). */
  deleted: number;
  skipped: number;
  skipped_by_reason: Partial<Record<PurgeSkipReason, number>>;
  /** A small sample of the rows deleted / to be deleted, for eyeballing. */
  sample: Array<{ id: string; company: string; title: string; kind: string }>;
}

interface Row {
  id: string;
  source: string;
  source_job_id: string;
  company: string;
  title: string;
  status: string;
  source_url: string;
  apply_url: string | null;
  apply_link_kind: string | null;
  content_fingerprint: string | null;
  application_id: string | null;
  raw_payload: string | null;
}

const SAMPLE_SIZE = 15;

export function purgeAggregatorLeads(db: Database.Database, opts: { apply: boolean }): PurgeReport {
  const report: PurgeReport = {
    apply: opts.apply,
    examined: 0,
    rederived_changed: 0,
    kinds: {},
    rejected_kind: 0,
    deleted: 0,
    skipped: 0,
    skipped_by_reason: {},
    sample: [],
  };
  if (!hasTable(db, 'job_leads')) return report;

  const rejectKinds = new Set(getConfig<string[]>(db, 'lead_reject_link_kinds'));
  const rows = db
    .prepare(
      `SELECT id, source, source_job_id, company, title, status, source_url, apply_url, apply_link_kind,
              content_fingerprint, application_id, raw_payload
         FROM job_leads
        WHERE source = 'google_jobs'`,
    )
    .all() as Row[];

  const hasResumes = hasTable(db, 'tailored_resumes');
  const hasEmail = hasTable(db, 'email_events');
  const resumeChild = hasResumes ? db.prepare(`SELECT 1 FROM tailored_resumes WHERE lead_id = ? LIMIT 1`) : null;
  const emailLink = hasEmail ? db.prepare(`SELECT 1 FROM email_events WHERE linked_job_lead_id = ? LIMIT 1`) : null;
  const updateKind = db.prepare(`UPDATE job_leads SET apply_url = @url, apply_link_kind = @kind WHERE id = @id`);
  const del = db.prepare(`DELETE FROM job_leads WHERE id = ?`);

  const skip = (r: PurgeSkipReason): void => {
    report.skipped_by_reason[r] = (report.skipped_by_reason[r] ?? 0) + 1;
    report.skipped += 1;
  };

  const run = db.transaction(() => {
    for (const r of rows) {
      report.examined += 1;
      const next = rederiveStoredApplyLink(r);
      report.kinds[next.kind] = (report.kinds[next.kind] ?? 0) + 1;
      if (next.url !== r.apply_url || next.kind !== r.apply_link_kind) {
        report.rederived_changed += 1;
        if (opts.apply) updateKind.run({ id: r.id, url: next.url, kind: next.kind });
      }
      if (!rejectKinds.has(next.kind)) continue;
      report.rejected_kind += 1;

      if (r.application_id) {
        skip('application');
        continue;
      }
      if (resumeChild?.get(r.id)) {
        skip('tailored_resume');
        continue;
      }
      if (emailLink?.get(r.id)) {
        skip('email_link');
        continue;
      }
      if (OWNER_STATUSES.has(r.status)) {
        skip('owner_status');
        continue;
      }

      report.deleted += 1;
      if (report.sample.length < SAMPLE_SIZE) {
        report.sample.push({ id: r.id, company: r.company, title: r.title, kind: next.kind });
      }
      if (opts.apply) {
        // Id-only: the job may be fine — only the link was bad — so the same
        // posting found later with a direct link must be accepted.
        writeTombstone(db, {
          source: r.source,
          source_job_id: r.source_job_id,
          content_fingerprint: r.content_fingerprint,
          company: r.company,
          title: r.title,
          reason: `link:${next.kind}`,
          match: 'id',
        });
        del.run(r.id);
      }
    }
  });
  run();
  return report;
}

function printHuman(r: PurgeReport): void {
  console.log(`${r.examined} search-sourced lead(s) examined.${r.apply ? '' : '  (dry run — pass --apply to write)'}`);
  console.log(`Re-derived link/kind differs from stored: ${r.rederived_changed}`);
  console.log(`Link kinds after re-derivation: ${JSON.stringify(r.kinds)}`);
  console.log(`Rejected by link kind: ${r.rejected_kind}`);
  console.log(`${r.apply ? 'Deleted' : 'Would delete'}: ${r.deleted} (each with an id-only tombstone)`);
  console.log(`Skipped: ${r.skipped} ${JSON.stringify(r.skipped_by_reason)}`);
  if (r.sample.length > 0) {
    console.log(`\nSample (first ${r.sample.length}):`);
    for (const s of r.sample) console.log(`  [${s.kind}] ${s.company} — ${s.title}  (${s.id})`);
  }
  console.log(r.apply ? '\nApplied.' : '\nDry run — nothing written. Re-run with --apply.');
}

function main(argv: string[]): void {
  const dbPath = argv.find((a) => !a.startsWith('--'));
  if (!dbPath) {
    process.stderr.write('usage: purge-aggregator-leads <db-path> [--apply] [--json]\n');
    process.exit(2);
  }
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');
  // Opened directly (not initDb, whose info log goes to stdout and would corrupt
  // --json). This is a post-deploy release step: the schema must already carry
  // the tombstone table — a one-off script does not migrate the prod DB.
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  if (!hasTable(db, 'job_lead_tombstones')) {
    process.stderr.write(
      'job_lead_tombstones is missing — deploy the backend (which runs the migration) before purging.\n',
    );
    process.exit(1);
  }
  const report = purgeAggregatorLeads(db, { apply });
  if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);
}

// Run only when invoked directly (under vitest argv[1] is the runner → no-op on import).
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
