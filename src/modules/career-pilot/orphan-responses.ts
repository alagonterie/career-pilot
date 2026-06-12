/**
 * Action-response orphan sweep (STRATEGY.md §24.66).
 *
 * The §6.1 action round-trip writes host responses into inbound.db as
 * `cp-resp-<requestId>` system rows (trigger:0); the container's `sendAction`
 * polls for the matching row with a short deadline and marks the one it
 * consumes completed. A response landing after that deadline is addressed to
 * nobody — it stays `pending` forever, and enough of them crowd real work out
 * of the poll loop's newest-N prompt window (the 2026-06-12 daily-briefing
 * starvation incident).
 *
 * Called from `src/host-sweep.ts` inside
 * MODULE-HOOK:career-pilot-orphan-responses. Host-side because the host is
 * inbound.db's single writer. Best-effort: never throws.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export function expireOrphanedActionResponses(inDb: Database.Database, session: Session): void {
  try {
    const ttlSec = getConfig<number>(getDb(), 'action_response_orphan_ttl_sec');
    const cutoff = new Date(Date.now() - ttlSec * 1000).toISOString();
    const result = inDb
      .prepare(
        `UPDATE messages_in
            SET status = 'completed'
          WHERE kind = 'system'
            AND status = 'pending'
            AND id LIKE 'cp-resp-%'
            AND datetime(timestamp) <= datetime(?)`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      log.warn('career-pilot: expired orphaned action responses', {
        sessionId: session.id,
        count: result.changes,
      });
    }
  } catch (err) {
    log.warn('career-pilot: orphan response sweep failed', { sessionId: session.id, err });
  }
}
