/**
 * Idempotent host-side bootstrap for the job-scrape recurring task
 * (Phase 9 §24.51 — the pool-replenishment cron / Phase-3 scrape foundation).
 *
 * Mirrors pipeline-scribe-bootstrap.ts. Reuses NanoClaw's `messages_in` task
 * storage + host-sweep poll loop + recurrence cloning — the only shape
 * differences vs the curator are SERIES_ID, the prompt sentinel, and the cron
 * default. A daily fire wakes the orchestrator with `[scheduled trigger:
 * job-scrape]`; the persona dispatches the `scrape-jobs` subagent to refresh
 * the `job_leads` pool (quietly — killer-match surfaces the standouts). Owner
 * group only (the call site in container-runner.ts is folder-gated).
 *
 * Defaults (overridable via the `preferences` table):
 *   - `job_scrape_enabled` = true
 *   - `job_scrape_cron`    = "0 5 * * *"   (05:00 TZ-local, ahead of the
 *                                            06:00→08:00 morning cron cascade)
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { getConfig } from '../../get-config.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

const SERIES_ID = 'job-scrape';
const TASK_PROMPT = '[scheduled trigger: job-scrape]';

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

export function readJobScrapePreferences(centralDb: Database.Database): BootstrapPreferences {
  // Defaults (job_scrape_enabled=true, job_scrape_cron=0 5 * * *) live in
  // config/defaults.json; getConfig resolves env > preferences table > defaults.
  return {
    enabled: getConfig<boolean>(centralDb, 'job_scrape_enabled'),
    cronExpr: getConfig<string>(centralDb, 'job_scrape_cron'),
  };
}

export function hasLiveJobScrapeTask(inDb: Database.Database): boolean {
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

export function ensureJobScrapeTask(
  centralDb: Database.Database,
  inDb: Database.Database,
  _agentGroup: AgentGroup,
  _session: Session,
): BootstrapResult {
  const prefs = readJobScrapePreferences(centralDb);
  if (!prefs.enabled) {
    return { action: 'skipped_disabled' };
  }
  if (hasLiveJobScrapeTask(inDb)) {
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
  log.info('job-scrape task inserted', {
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
