/**
 * Migration 123 — public_audit_trail.seq monotonic cursor.
 *
 * `public_audit_trail.id` (`pat-${Date.now()}-${rand}`) is not a usable
 * pagination / SSE cursor, and a `?since=<ts>` resume ties at millisecond
 * granularity (multiple rows can land in one host tick) → duplicates (`>=`)
 * or gaps (`>`) on reconnect across the Cloudflare Tunnel idle timeout.
 * `seq` is a strictly monotonic integer assigned `MAX(seq)+1` at insert by
 * the row writers (`mirrorFunnelEvent`, `handleRecordProgress`) under the
 * host's single synchronous writer. `/api/activity[/stream]` uses it as the
 * cursor / SSE `id:`. See PORTAL.md §8.3.
 *
 * Backfill assigns 1..N over existing rows in (ts, id) order via ROW_NUMBER
 * (SQLite ≥3.25, bundled with better-sqlite3). Prod is pre-LIVE_MODE with
 * near-zero rows and the dev DB resets per e2e, so the backfill is trivial
 * in practice. Idempotent via the PRAGMA column guard; the unique index uses
 * IF NOT EXISTS.
 *
 * Schema reference: STRATEGY.md §3 + §24.14.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration123: Migration = {
  version: 123,
  name: 'career-pilot-audit-seq',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('public_audit_trail')").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!cols.has('seq')) {
      db.prepare('ALTER TABLE public_audit_trail ADD COLUMN seq INTEGER').run();
      db.exec(`
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY ts ASC, id ASC) AS rn
          FROM public_audit_trail
        )
        UPDATE public_audit_trail
           SET seq = (SELECT rn FROM ordered WHERE ordered.id = public_audit_trail.id);
      `);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq ON public_audit_trail(seq)');
  },
};
