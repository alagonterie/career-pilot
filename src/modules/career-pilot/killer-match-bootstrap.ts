/**
 * Idempotent host-side bootstrap for the killer-match recurring task
 * (Phase 3.1 §24.7 component 2).
 *
 * Mirrors daily-briefing-bootstrap.ts. Reuses NanoClaw's messages_in
 * task storage + host-sweep poll loop + recurrence cloning. The only
 * shape differences vs daily-briefing are the SERIES_ID, the prompt
 * sentinel, and the default cron (every 30min during waking hours).
 *
 * Per [[feedback-nanoclaw-infra-first]]: we reuse the existing
 * scheduling primitive rather than building anything parallel.
 *
 * Defaults (overridable via the `preferences` table):
 *   - `killer_match_enabled` = true   (bootstrap skips if "false")
 *   - `killer_match_cron`    = "* / 30 7-22 * * *"
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { getConfig } from '../../get-config.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

const SERIES_ID = 'killer-match';
const TASK_PROMPT = '[scheduled trigger: killer-match]';

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

export function readKillerMatchPreferences(centralDb: Database.Database): BootstrapPreferences {
  // Defaults (killer_match_enabled=true, killer_match_cron=*/30 7-22 * * *) live
  // in config/defaults.json; getConfig resolves env > preferences table > defaults.
  return {
    enabled: getConfig<boolean>(centralDb, 'killer_match_enabled'),
    cronExpr: getConfig<string>(centralDb, 'killer_match_cron'),
  };
}

export function hasLiveKillerMatchTask(inDb: Database.Database): boolean {
  const row = inDb
    .prepare(
      "SELECT id FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused') LIMIT 1",
    )
    .get(SERIES_ID);
  return row !== undefined;
}

function generateBootstrapId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function computeNextFireTime(cronExpr: string): string {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  const next = interval.next().toISOString();
  if (!next) {
    throw new Error(`cron-parser returned no next fire time for "${cronExpr}"`);
  }
  return next;
}

export function ensureKillerMatchTask(
  centralDb: Database.Database,
  inDb: Database.Database,
  _agentGroup: AgentGroup,
  _session: Session,
): BootstrapResult {
  const prefs = readKillerMatchPreferences(centralDb);
  if (!prefs.enabled) {
    return { action: 'skipped_disabled' };
  }
  if (hasLiveKillerMatchTask(inDb)) {
    return { action: 'skipped_exists' };
  }
  const nextFireAt = computeNextFireTime(prefs.cronExpr);
  const newId = generateBootstrapId();
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
  log.info('killer-match task inserted', {
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
