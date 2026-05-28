/**
 * Idempotent host-side bootstrap for the funnel-curator recurring task
 * (Phase 3.2 §24.9 component 2).
 *
 * Mirrors killer-match-bootstrap.ts. Single daily fire at 07:30 (TZ-local)
 * — runs before the 08:00 daily-briefing so the briefing builder can read
 * the curator's materialized output downstream.
 *
 * Per [[feedback-nanoclaw-infra-first]]: reuses NanoClaw's `messages_in`
 * task storage + host-sweep poll loop + recurrence cloning. The only
 * shape differences vs killer-match are SERIES_ID, prompt sentinel, and
 * the cron default.
 *
 * Defaults (overridable via the `preferences` table):
 *   - `funnel_curator_enabled` = true
 *   - `funnel_curator_cron`    = "30 7 * * *"
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

const SERIES_ID = 'funnel-curator';
const TASK_PROMPT = '[scheduled trigger: funnel-curator]';

const DEFAULT_CRON_EXPR = '30 7 * * *';

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

export function readFunnelCuratorPreferences(centralDb: Database.Database): BootstrapPreferences {
  try {
    const rows = centralDb
      .prepare(
        "SELECT key, value FROM preferences WHERE key IN ('funnel_curator_enabled', 'funnel_curator_cron')",
      )
      .all() as Array<{ key: string; value: string }>;
    const lookup = new Map(rows.map((r) => [r.key, r.value]));
    const enabledRaw = lookup.get('funnel_curator_enabled');
    const enabled = enabledRaw !== 'false';
    const cronExpr = lookup.get('funnel_curator_cron') || DEFAULT_CRON_EXPR;
    return { enabled, cronExpr };
  } catch {
    return { enabled: true, cronExpr: DEFAULT_CRON_EXPR };
  }
}

export function hasLiveFunnelCuratorTask(inDb: Database.Database): boolean {
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

export function ensureFunnelCuratorTask(
  centralDb: Database.Database,
  inDb: Database.Database,
  _agentGroup: AgentGroup,
  _session: Session,
): BootstrapResult {
  const prefs = readFunnelCuratorPreferences(centralDb);
  if (!prefs.enabled) {
    return { action: 'skipped_disabled' };
  }
  if (hasLiveFunnelCuratorTask(inDb)) {
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
  log.info('funnel-curator task inserted', {
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
