/**
 * Migration 125 — funnel_events.proactive flag.
 *
 * Whether the session that recorded this funnel event was woken by a
 * proactive trigger (scheduled `task` / `webhook` / agent `system`) vs a
 * reactive direct message (`chat` / `chat-sdk`) — the §24.18 pause-gate
 * convention codified in `countDueReactiveMessages`. Stamped at record time
 * by `handleRecordFunnelEvent` from `deriveProactive(inDb)` so the public
 * mirror (`mirrorFunnelEvent`) — and its `resanitizeApplicationAuditTrail`
 * re-run, which has no session context — can reproduce the ◆ proactive
 * marker from `funnel_events` truth rather than re-deriving it.
 *
 * Idempotent via the PRAGMA column guard (same pattern as migration 123).
 *
 * Schema reference: STRATEGY.md §3 + §24.24.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration125: Migration = {
  version: 125,
  name: 'career-pilot-funnel-events-proactive',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('funnel_events')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('proactive')) {
      db.prepare('ALTER TABLE funnel_events ADD COLUMN proactive INTEGER NOT NULL DEFAULT 0').run();
    }
  },
};
