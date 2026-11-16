/**
 * Board targets reader.
 *
 * Resolves the boards a scan covers from the `active` rows of the `ats_watchlist`
 * table (STRATEGY.md §24.200 D7) — no longer from `ats-targets.json`, which is
 * now read only by the watchlist's boot-time seed. `priority` filters on the
 * row's `tier`; `company` is an exact, case-insensitive name match. Host-side.
 *
 * Spec: STRATEGY.md §24.5 what-lands #4, §24.200 D7.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../../db/connection.js';
import { listActiveBoards } from '../ats-watchlist.js';
import type { TargetEntry, Source, SourcePriority } from './types.js';

export function filterTargets(
  args: { priority?: SourcePriority; company?: string },
  db: Database.Database = getDb(),
): TargetEntry[] {
  return listActiveBoards(db, { tier: args.priority, company: args.company }).map((r) => ({
    company: r.company,
    source: r.ats,
    token: r.token,
    priority: r.tier,
    ...(r.notes ? { notes: r.notes } : {}),
  }));
}

/** Re-export common types for adapter consumers. */
export type { TargetEntry, Source, SourcePriority };
