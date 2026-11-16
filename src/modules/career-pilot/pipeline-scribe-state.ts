/**
 * The pipeline-scribe's latest run, read and reconciled against live
 * application state (STRATEGY.md §24.199; shared by §24.203).
 *
 * One reader for both consumers: the agent's `read_pipeline_state` action and
 * the owner's `/admin` Pipeline tab. The stored run is a snapshot and is never
 * rewritten; on the way out:
 *   - attention for an application that is now closed is dropped;
 *   - each narrative naming a known application carries its live status as
 *     `application_status`, so a stale `current_state` is visible.
 *
 * Tolerant: a missing table yields `null`, and a JSON column that does not
 * parse to an array yields `[]` for that list only.
 */
import type Database from 'better-sqlite3';

import { hasTable } from '../../db/connection.js';
import { isClosedStatus } from './win-confidence.js';

type ScribeItem = Record<string, unknown>;

export interface LatestScribeState {
  id: string;
  run_at: string;
  gmail_history_id: string | null;
  /** Raw stored JSON text; the caller parses it if it needs it. */
  calendar_sync_tokens: string;
  narratives: ScribeItem[];
  attention: ScribeItem[];
  suggestions: unknown[];
  cheap_out: number;
  cost_usd: number | null;
}

interface ScribeOutputRow {
  id: string;
  run_at: string;
  gmail_history_id: string | null;
  calendar_sync_tokens: string;
  narratives_json: string;
  attention_json: string;
  suggestions_json: string;
  cheap_out: number;
  cost_usd: number | null;
}

function parseArray(raw: string | null | undefined): unknown[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asItems(list: unknown[]): ScribeItem[] {
  return list.filter((x): x is ScribeItem => typeof x === 'object' && x !== null && !Array.isArray(x));
}

/** Live `applications.status` for every application id named by the given items. */
export function liveApplicationStatuses(db: Database.Database, items: ScribeItem[]): Map<string, string | null> {
  const ids = [
    ...new Set(items.map((x) => x?.application_id).filter((v): v is string => typeof v === 'string' && v !== '')),
  ];
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(`SELECT id, status FROM applications WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .all(...ids) as Array<{ id: string; status: string | null }>;
  for (const r of rows) out.set(r.id, r.status);
  return out;
}

/** The newest `pipeline_scribe_output` run, reconciled; `null` when there is none. */
export function readLatestScribeState(db: Database.Database): LatestScribeState | null {
  if (!hasTable(db, 'pipeline_scribe_output')) return null;
  const row = db
    .prepare(
      `SELECT id, run_at, gmail_history_id, calendar_sync_tokens,
              narratives_json, attention_json, suggestions_json,
              cheap_out, cost_usd
         FROM pipeline_scribe_output
        ORDER BY run_at DESC
        LIMIT 1`,
    )
    .get() as ScribeOutputRow | undefined;
  if (!row) return null;

  const narratives = asItems(parseArray(row.narratives_json));
  const storedAttention = asItems(parseArray(row.attention_json));

  const liveStatus = liveApplicationStatuses(db, [...narratives, ...storedAttention]);
  for (const n of narratives) {
    const appId = n.application_id;
    if (typeof appId === 'string' && liveStatus.has(appId)) n.application_status = liveStatus.get(appId);
  }
  const attention = storedAttention.filter((a) => {
    const appId = a.application_id;
    return !(typeof appId === 'string' && isClosedStatus(liveStatus.get(appId)));
  });

  return {
    id: row.id,
    run_at: row.run_at,
    gmail_history_id: row.gmail_history_id,
    calendar_sync_tokens: row.calendar_sync_tokens,
    narratives,
    attention,
    suggestions: parseArray(row.suggestions_json),
    cheap_out: row.cheap_out,
    cost_usd: row.cost_usd,
  };
}
