/**
 * Idempotent host-side bootstrap for the daily-briefing recurring task
 * (Phase 3.1 §24.6 component 1).
 *
 * Called from container-runner.ts on each spawn for the career-pilot group.
 * If a live (pending/paused) daily-briefing task already exists for this
 * session, no-op. Otherwise, insert one via the existing `insertTask`
 * helper from `src/modules/scheduling/db.ts`. NanoClaw's host-sweep +
 * recurrence module (`src/modules/scheduling/recurrence.ts`) clones the
 * task forward after each completion — no further action required from us.
 *
 * Per [[feedback-nanoclaw-infra-first]]: we use NanoClaw's existing
 * scheduling infrastructure (messages_in rows with kind='task', cron-parser
 * recurrence, TIMEZONE-aware) rather than building a parallel scheduler.
 *
 * Defaults (overridable via the `preferences` table):
 *   - `daily_briefing_enabled` = "true"  (string; bootstrap skips if "false")
 *   - `daily_briefing_time` = "0 8 * * *"  (TZ-local 8am daily)
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

/**
 * Stable identifier shared across every daily-briefing row (initial
 * insert + every recurrence clone). The row `id` itself is generated
 * fresh on each insert to avoid UNIQUE-constraint collisions with
 * earlier completed rows that remain in the DB for audit.
 */
const SERIES_ID = 'daily-briefing';
const TASK_PROMPT = '[scheduled trigger: daily-briefing]';

const DEFAULT_CRON_EXPR = '0 8 * * *'; // 8am TZ-local daily

export interface BootstrapPreferences {
  enabled: boolean;
  cronExpr: string;
}

export interface BootstrapResult {
  action: 'inserted' | 'skipped_exists' | 'skipped_disabled';
  taskId?: string;
  nextFireAt?: string;
  recurrence?: string;
}

/**
 * Read daily-briefing preferences from the central DB. Falls back to
 * defaults when the table is missing or the keys are absent (e.g., a
 * fresh dev environment that hasn't run config seeding yet).
 */
export function readBriefingPreferences(centralDb: Database.Database): BootstrapPreferences {
  try {
    const rows = centralDb
      .prepare(
        "SELECT key, value FROM preferences WHERE key IN ('daily_briefing_enabled', 'daily_briefing_time')",
      )
      .all() as Array<{ key: string; value: string }>;
    const lookup = new Map(rows.map((r) => [r.key, r.value]));
    // enabled defaults to true; only the literal "false" disables.
    const enabledRaw = lookup.get('daily_briefing_enabled');
    const enabled = enabledRaw !== 'false';
    const cronExpr = lookup.get('daily_briefing_time') || DEFAULT_CRON_EXPR;
    return { enabled, cronExpr };
  } catch {
    return { enabled: true, cronExpr: DEFAULT_CRON_EXPR };
  }
}

/**
 * True iff the session's inbound.db already has a live (pending/paused)
 * row in the daily-briefing series. Matches by `series_id` because the
 * recurrence handler generates fresh ids on each clone but preserves
 * the series_id we passed at insert.
 */
export function hasLiveDailyBriefingTask(inDb: Database.Database): boolean {
  const row = inDb
    .prepare(
      "SELECT id FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused') LIMIT 1",
    )
    .get(SERIES_ID);
  return row !== undefined;
}

/**
 * Generate a row id with the same shape NanoClaw's recurrence handler
 * uses for clones (`task-<ts>-<rand>`). The series_id stays
 * `daily-briefing` for stable dedup.
 */
function generateBootstrapId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute the first fire time for the given cron expression in the
 * configured timezone. Matches the tz semantics used by
 * `src/modules/scheduling/recurrence.ts` so the initial fire and all
 * subsequent recurrence clones live on the same timeline.
 */
export function computeNextFireTime(cronExpr: string): string {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  const next = interval.next().toISOString();
  if (!next) {
    throw new Error(`cron-parser returned no next fire time for "${cronExpr}"`);
  }
  return next;
}

export function ensureDailyBriefingTask(
  centralDb: Database.Database,
  inDb: Database.Database,
  _agentGroup: AgentGroup,
  _session: Session,
): BootstrapResult {
  const prefs = readBriefingPreferences(centralDb);
  if (!prefs.enabled) {
    return { action: 'skipped_disabled' };
  }
  if (hasLiveDailyBriefingTask(inDb)) {
    return { action: 'skipped_exists' };
  }
  const nextFireAt = computeNextFireTime(prefs.cronExpr);
  const newId = generateBootstrapId();
  // Direct INSERT (rather than scheduling/db.ts `insertTask`) so we can
  // set series_id independently of id — `insertTask` hard-codes
  // `series_id = id`, which collides with completed rows from prior fires.
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (@id, @seq, datetime('now'), 'pending', 0, @processAfter, @recurrence, 'task', NULL, NULL, NULL, @content, @seriesId)`,
    )
    .run({
      id: newId,
      seq: nextEvenSeq(inDb),
      processAfter: nextFireAt,
      recurrence: prefs.cronExpr,
      content: JSON.stringify({ prompt: TASK_PROMPT, script: null }),
      seriesId: SERIES_ID,
    });
  log.info('daily-briefing task inserted', {
    rowId: newId,
    seriesId: SERIES_ID,
    recurrence: prefs.cronExpr,
    nextFireAt,
  });
  return {
    action: 'inserted',
    taskId: newId,
    nextFireAt,
    recurrence: prefs.cronExpr,
  };
}
