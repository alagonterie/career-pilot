/**
 * Idempotent host-side bootstrap for the pipeline-scribe recurring task
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
 *   - `pipeline_scribe_enabled` = true
 *   - `pipeline_scribe_cron`    = "30 7 * * *"
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { getConfig } from '../../get-config.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';

// SERIES_ID deliberately keeps the pre-rename literal 'funnel-curator'
// (§24.59 / §24.152 D7): it is the recurring task's series_id in NanoClaw's
// live `messages_in` queue (a separate inbound DB the central-DB migration
// system does not manage), so renaming it would orphan the live series on
// deployed boxes for zero visitor-facing benefit. The PROMPT follows the
// subagent's rename to pipeline-scribe, and ensure() reconciles the live row's
// stored prompt when this constant changes.
const SERIES_ID = 'funnel-curator';
const TASK_PROMPT = '[scheduled trigger: pipeline-scribe]';

export interface BootstrapPreferences {
  enabled: boolean;
  cronExpr: string;
}

export interface BootstrapResult {
  action: 'inserted' | 'skipped_exists' | 'skipped_disabled' | 'reconciled_prompt';
  taskId?: string;
  nextFireAt?: string;
  recurrence?: string;
}

export function readPipelineScribePreferences(centralDb: Database.Database): BootstrapPreferences {
  // Defaults (pipeline_scribe_enabled=true, pipeline_scribe_cron=30 7 * * *) live
  // in config/defaults.json; getConfig resolves env > preferences table > defaults.
  return {
    enabled: getConfig<boolean>(centralDb, 'pipeline_scribe_enabled'),
    cronExpr: getConfig<string>(centralDb, 'pipeline_scribe_cron'),
  };
}

function readLiveTask(inDb: Database.Database): { id: string; content: string } | undefined {
  return inDb
    .prepare(
      "SELECT id, content FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused') LIMIT 1",
    )
    .get(SERIES_ID) as { id: string; content: string } | undefined;
}

export function hasLivePipelineScribeTask(inDb: Database.Database): boolean {
  return readLiveTask(inDb) !== undefined;
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

export function ensurePipelineScribeTask(
  centralDb: Database.Database,
  inDb: Database.Database,
  _agentGroup: AgentGroup,
  _session: Session,
): BootstrapResult {
  const prefs = readPipelineScribePreferences(centralDb);
  if (!prefs.enabled) {
    return { action: 'skipped_disabled' };
  }
  const live = readLiveTask(inDb);
  if (live) {
    // Prompt reconciliation (§24.59): when the sentinel constant changes (the
    // subagent rename), the recurring row a deployed box already holds keeps
    // firing the OLD prompt forever — which the updated persona no longer
    // handles (it falls into the unknown-trigger note and the sweep silently
    // stops materializing). Converge the stored prompt in place; the series,
    // recurrence, and next fire time are untouched.
    try {
      const parsed = JSON.parse(live.content) as { prompt?: string; script?: unknown };
      if (parsed.prompt !== TASK_PROMPT) {
        inDb
          .prepare('UPDATE messages_in SET content = @content WHERE id = @id')
          .run({ content: JSON.stringify({ ...parsed, prompt: TASK_PROMPT }), id: live.id });
        log.info('pipeline-scribe task prompt reconciled', {
          rowId: live.id,
          seriesId: SERIES_ID,
          prompt: TASK_PROMPT,
        });
        return { action: 'reconciled_prompt', taskId: live.id };
      }
    } catch {
      // Malformed content JSON — leave the row alone; the sweep loop owns
      // surfacing that as a delivery error.
    }
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
  log.info('pipeline-scribe task inserted', {
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
