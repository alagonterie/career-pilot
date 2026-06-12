/**
 * src/modules/portal/dev/app-data-reset.ts — the shared career-pilot DOMAIN-data
 * reset primitives (STRATEGY §24.41 + §24.48).
 *
 * SINGLE SOURCE OF TRUTH for which tables a reset clears, split into the
 * funnel/app-data group and the conversation-session group. Two callers share
 * it so they can never drift:
 *   - `scripts/reset-dev.ts` — the CLI/CI SOFT reset (clears `APP_DATA_TABLES`).
 *   - the dev inspector's scoped `/api/dev/reset` endpoint (§24.48) — clears a
 *     subset per the requested scope, live on the running host.
 *
 * This list is an explicit ALLOW-LIST. It NEVER includes the NanoClaw core
 * (permissions/messaging = pairing), config (preferences/system_modes), or
 * schema_version. The persona (`candidate_profile`) is handled separately by the
 * `profile`/`everything` scopes — it is deliberately NOT in these lists. When a
 * new career-pilot domain table lands, ADD IT to the right group here.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

/** Funnel / application / lead state — the board a reset rebuilds from scratch. */
export const FUNNEL_DATA_TABLES = [
  'applications',
  'funnel_events',
  'funnel_curator_output',
  'public_funnel_view',
  'public_audit_trail',
  'learnings',
  'job_leads',
  'simulator_runs',
  'email_events',
  'gmail_sync_state',
  'calendar_sync_state',
] as const;

/**
 * Conversation sessions — the DB rows. The JSONL transcripts + per-session
 * inbound DBs live on disk and are cleared via `clearSessionTranscripts`.
 */
export const SESSION_TABLES = ['sessions'] as const;

/** The full soft-reset app-data set (funnel data + sessions) — what `reset-dev.ts` clears. */
export const APP_DATA_TABLES = [...FUNNEL_DATA_TABLES, ...SESSION_TABLES] as const;

/**
 * DELETE every present table in `tables` inside one transaction with FKs off (so
 * a multi-table wipe never trips a parent/child ordering constraint). Restores
 * the connection's prior `foreign_keys` state afterward — this runs on the
 * long-lived host connection, not a throwaway one, so it must leave no residue.
 * Returns per-table row counts (only for tables that actually exist).
 */
export function wipeTables(db: Database.Database, tables: readonly string[]): Record<string, number> {
  const prevFk = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    const cleared: Record<string, number> = {};
    const run = db.transaction(() => {
      for (const t of tables) {
        if (!present.has(t)) continue;
        cleared[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
        db.prepare(`DELETE FROM ${t}`).run();
      }
    });
    run();
    return cleared;
  } finally {
    db.pragma(`foreign_keys = ${prevFk === 1 ? 'ON' : 'OFF'}`);
  }
}

/**
 * Remove the contents of `<dataDir>/v2-sessions/*` — conversation transcripts and
 * the per-session inbound DBs. The directory stays; only its entries go (the next
 * session start recreates its own dir + re-bootstraps the recurring crons).
 * Returns the number of entries removed. Tolerates absence, and tolerates a
 * locked entry (an open DB handle — EBUSY on Windows): best-effort, skip and
 * continue rather than failing the whole reset.
 */
export function clearSessionTranscripts(dataDir: string): number {
  const sessionsDir = path.join(dataDir, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(sessionsDir)) {
    try {
      fs.rmSync(path.join(sessionsDir, entry), { recursive: true, force: true });
      removed++;
    } catch {
      // Locked by an open handle — leave it; the reset is best-effort.
    }
  }
  return removed;
}
