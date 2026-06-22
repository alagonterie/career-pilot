/**
 * Idempotent host-side bootstrap for the close-detection recurring task
 * (Phase 3.2 §24.8 component 1).
 *
 * Mirrors killer-match-bootstrap.ts. Single daily fire at 06:00 (TZ-local)
 * — runs before the 07:30 pipeline-scribe and the 08:00 daily-briefing so
 * downstream consumers see a clean pool.
 *
 * Per [[feedback-nanoclaw-infra-first]]: reuses NanoClaw's `messages_in`
 * task storage + host-sweep poll loop + recurrence cloning. The only
 * shape differences vs the other heartbeat tasks are SERIES_ID, prompt
 * sentinel, and cron default.
 *
 * Defaults (overridable via the `preferences` table):
 *   - `close_detection_enabled` = true
 *   - `close_detection_cron`    = "0 6 * * *"
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { getConfig } from '../../get-config.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

import { preWakeScript } from './pre-wake-script.js';

const SERIES_ID = 'close-detection';
const TASK_PROMPT = '[scheduled trigger: close-detection]';

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

export function readCloseDetectionPreferences(centralDb: Database.Database): BootstrapPreferences {
  // Defaults (close_detection_enabled=true, close_detection_cron=0 6 * * *) live
  // in config/defaults.json; getConfig resolves env > preferences table > defaults.
  return {
    enabled: getConfig<boolean>(centralDb, 'close_detection_enabled'),
    cronExpr: getConfig<string>(centralDb, 'close_detection_cron'),
  };
}

export function hasLiveCloseDetectionTask(inDb: Database.Database): boolean {
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

export function ensureCloseDetectionTask(
  centralDb: Database.Database,
  inDb: Database.Database,
  _agentGroup: AgentGroup,
  _session: Session,
): BootstrapResult {
  const prefs = readCloseDetectionPreferences(centralDb);
  if (!prefs.enabled) {
    return { action: 'skipped_disabled' };
  }
  if (hasLiveCloseDetectionTask(inDb)) {
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
      content: JSON.stringify({ prompt: TASK_PROMPT, script: preWakeScript('close-detection') }),
      seriesId: SERIES_ID,
    });
  log.info('close-detection task inserted', {
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
