/**
 * Migration 143 — consolidate the master-résumé attribution source onto the
 * fixed, transparent named code `master_resume_pdf` (STRATEGY.md §24.177 D4
 * follow-up).
 *
 * Pre-§24.177, the master-résumé PDF footer minted a RANDOM `/r/<code>` per the
 * §24.74 scheme. §24.177 switched `ensureMasterPdfLink` to a single fixed source
 * (`master_resume_pdf`) so the master download foots a self-describing
 * `?from=master_resume_pdf`. But a DB seeded before §24.177 still carries the
 * legacy random-coded `master_pdf` row — which the /admin Visitors tab then shows
 * as the master source with `?from=<random>`. This migration retires those legacy
 * rows onto the fixed source: it preserves the click history (repoints
 * visit_telemetry) and folds everything into ONE canonical row.
 *
 * Trade-off (accepted): a forwarded résumé carrying an OLD `/r/<random>` master
 * link stops resolving (it lands the visitor on '/' without recording) — the
 * master source is now the transparent `?from=master_resume_pdf`. The candidate's
 * search is freshly launched, so any such distribution is negligible; per-recipient
 * outreach links (unique, opaque) are untouched.
 *
 * Idempotent + safe on a DB that never minted a master link (no rows → no-op).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

const MASTER_SLUG = 'master_resume_pdf';

export const migration143: Migration = {
  version: 143,
  name: 'career-pilot-master-pdf-named-source',
  up(db: Database.Database) {
    // Legacy random-coded master_pdf rows (the canonical fixed code excluded).
    const legacy = db
      .prepare(`SELECT code, created_at FROM attribution_link WHERE artifact_type = 'master_pdf' AND code != ?`)
      .all(MASTER_SLUG) as Array<{ code: string; created_at: string }>;
    if (legacy.length === 0) return; // fresh DB (or already consolidated) — nothing to do

    // Ensure the canonical fixed-code row exists, dated to the OLDEST legacy row
    // so "minted since" stays continuous.
    const oldest = legacy.reduce((a, b) => (a.created_at <= b.created_at ? a : b)).created_at;
    db.prepare(
      `INSERT OR IGNORE INTO attribution_link
         (code, artifact_type, company, recipient, application_id, dest_path, created_at, expires_at)
       VALUES (?, 'master_pdf', NULL, NULL, NULL, '/', ?, NULL)`,
    ).run(MASTER_SLUG, oldest);

    // Repoint each legacy row's clicks onto the canonical code, then drop the
    // legacy row — one clean master source, history preserved.
    const repoint = db.prepare('UPDATE visit_telemetry SET link_code = ? WHERE link_code = ?');
    const drop = db.prepare('DELETE FROM attribution_link WHERE code = ?');
    for (const { code } of legacy) {
      repoint.run(MASTER_SLUG, code);
      drop.run(code);
    }
  },
};
