/**
 * Migration 142 — funnel→pipeline internal rename (STRATEGY.md §24.152).
 *
 * Finishes the §24.59/§24.77 vocabulary migration. The visitor surface has read
 * "pipeline" since §24.77; the internal plumbing still said "funnel". Done now,
 * pre-production, so the first prod DB is born with clean naming (no legacy
 * `funnel` table at rest). See §24.152 for the full rename map + decisions.
 *
 * Renames (data-preserving + idempotent — each step guarded for re-run safety):
 *   - table  funnel_events       → pipeline_events       (+ its index)
 *   - table  public_funnel_view  → public_pipeline_view  (+ its index)
 *   - preferences keys  funnel_curator_*  → pipeline_scribe_*  (override-preserving)
 *
 * NOT renamed (§24.152 D7): the `funnel-curator` messages_in series-id — a
 * deliberate §24.59 keep, since renaming it would orphan NanoClaw's live
 * recurring-task rows on a deployed box for a never-surfaced internal id.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const PREFERENCE_KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['funnel_curator_enabled', 'pipeline_scribe_enabled'],
  ['funnel_curator_cron', 'pipeline_scribe_cron'],
  ['funnel_curator_gmail_lookback_days', 'pipeline_scribe_gmail_lookback_days'],
  ['funnel_curator_ghosting_thresholds_days', 'pipeline_scribe_ghosting_thresholds_days'],
  ['funnel_curator_max_narratives', 'pipeline_scribe_max_narratives'],
  ['funnel_curator_max_attention_items', 'pipeline_scribe_max_attention_items'],
  ['funnel_curator_skip_if_no_deltas', 'pipeline_scribe_skip_if_no_deltas'],
  ['funnel_curator_skip_classified_messages', 'pipeline_scribe_skip_classified_messages'],
];

export const migration142: Migration = {
  version: 142,
  name: 'career-pilot-funnel-to-pipeline-rename',
  up(db: Database.Database) {
    // --- table: funnel_events → pipeline_events ---
    if (tableExists(db, 'funnel_events') && !tableExists(db, 'pipeline_events')) {
      db.exec('ALTER TABLE funnel_events RENAME TO pipeline_events;');
    }
    db.exec('DROP INDEX IF EXISTS idx_funnel_events_app;');
    if (tableExists(db, 'pipeline_events')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_events_app ON pipeline_events(application_id, ts DESC);');
    }

    // --- table: public_funnel_view → public_pipeline_view ---
    if (tableExists(db, 'public_funnel_view') && !tableExists(db, 'public_pipeline_view')) {
      db.exec('ALTER TABLE public_funnel_view RENAME TO public_pipeline_view;');
    }
    db.exec('DROP INDEX IF EXISTS idx_public_funnel_view_stage;');
    if (tableExists(db, 'public_pipeline_view')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_public_pipeline_view_stage ON public_pipeline_view(stage);');
    }

    // --- preferences keys: funnel_curator_* → pipeline_scribe_* ---
    // Preserves any box-overridden value; guarded against a (theoretical)
    // pre-existing new key so the PK never conflicts. Unset keys fall through
    // to the renamed defaults.json defaults — no row needed.
    const rename = db.prepare(
      'UPDATE preferences SET key = @newKey WHERE key = @oldKey AND NOT EXISTS (SELECT 1 FROM preferences p WHERE p.key = @newKey)',
    );
    for (const [oldKey, newKey] of PREFERENCE_KEY_RENAMES) {
      rename.run({ oldKey, newKey });
    }
  },
};
