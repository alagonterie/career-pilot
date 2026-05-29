/**
 * Migration 122 — public_audit_trail.source_funnel_event_id.
 *
 * Links each mirrored audit row back to the funnel_events row it was
 * derived from, so Sub-milestone 4.3's retroactive resanitization can
 * find-and-replace an application's audit rows when its obfuscation
 * policy changes (public_state flip, or an obfuscated_label /
 * company_name / company_aliases edit).
 *
 * Nullable by design. Rows written before this migration stay NULL and
 * are simply not re-linkable — the DELETE in
 * resanitizeApplicationAuditTrail keys on this column, so NULL-linked
 * legacy rows are left untouched. In practice there are no such rows:
 * prod is pre-LIVE_MODE with no real audit data, and the dev DB is reset
 * per e2e run.
 *
 * Idempotent against a manually-patched DB via the PRAGMA guard, though
 * the migration runner's name-gate already guarantees single execution.
 *
 * Schema reference: STRATEGY.md §24.11.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration122: Migration = {
  version: 122,
  name: 'career-pilot-audit-source-funnel-event',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('public_audit_trail')").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!cols.has('source_funnel_event_id')) {
      db.prepare('ALTER TABLE public_audit_trail ADD COLUMN source_funnel_event_id TEXT').run();
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_audit_source_fe ON public_audit_trail(source_funnel_event_id)',
    );
  },
};
