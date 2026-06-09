/**
 * Interview-kit status-transition trigger (STRATEGY.md §24.53).
 *
 * The seam that turns "an interview now exists" into a kit. Called from the two
 * places application status transitions:
 *   - the deterministic converter (`applyFunnelFromEmailEvents` → its `changes[]`,
 *     invoked from `handlePersistFunnelState`), the primary path the recruiter-sim
 *     exercises; and
 *   - the agent-driven `handleUpdateApplication` path.
 *
 * On entry to an interview stage → enqueue a ONE-OFF `[scheduled trigger:
 * build-interview-kit]` wake (the orchestrator does the LLM work next turn); on
 * entry to a terminal stage → archive the application's active kits. Synchronous +
 * defensive (one bad change never blocks the others or the caller).
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

import { archiveKitsForApplication } from './interview-kit-actions.js';
import { hasActiveKit, isInterviewRoundStatus, isTerminalStatus } from './interview-kit-store.js';

/**
 * A status transition to react to. Structurally a superset of
 * `funnel-apply.ts`'s `FunnelApplyChange` (so its `changes[]` is assignable) and
 * of the inline change the `update_application` path builds. Only `to` +
 * `application_id` are read.
 */
export interface StatusTransition {
  application_id: string;
  to: string;
  from?: string | null;
}

const SERIES_PREFIX = 'build-interview-kit';

/** Per-(application, round) series id — dedups pending wakes. */
export function kitWakeSeriesId(applicationId: string, round: string): string {
  return `${SERIES_PREFIX}:${applicationId}:${round.toUpperCase()}`;
}

/** The turn input the orchestrator parses (application_id + round ride the sentinel). */
export function buildKitWakePrompt(applicationId: string, round: string): string {
  return `[scheduled trigger: build-interview-kit] application_id=${applicationId} round=${round.toUpperCase()}`;
}

function hasPendingKitWake(inDb: Database.Database, seriesId: string): boolean {
  const row = inDb
    .prepare(
      "SELECT id FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused') LIMIT 1",
    )
    .get(seriesId);
  return row !== undefined;
}

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Enqueue a one-off build-interview-kit wake (fires on the next host sweep —
 * `process_after = now`, no recurrence). Dedups on the per-(app, round) series id
 * so a second transition before the first wake fires doesn't stack. Returns true
 * when a row was inserted.
 */
export function enqueueKitWake(inDb: Database.Database, applicationId: string, round: string): boolean {
  const seriesId = kitWakeSeriesId(applicationId, round);
  if (hasPendingKitWake(inDb, seriesId)) return false;
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (@id, @seq, datetime('now'), 'pending', 0, datetime('now'), NULL, 'task', NULL, NULL, NULL, @content, @seriesId)`,
    )
    .run({
      id: generateTaskId(),
      seq: nextEvenSeq(inDb),
      content: JSON.stringify({ prompt: buildKitWakePrompt(applicationId, round) }),
      seriesId,
    });
  log.info('interview-kit wake enqueued', { applicationId, round, seriesId });
  return true;
}

/**
 * React to a batch of status transitions. On entry to an interview stage →
 * enqueue a kit wake (unless auto-gen is off or an active kit already exists for
 * that round). On entry to a terminal stage → archive the application's active
 * kits (fire-and-forget; it touches Drive). Never throws.
 */
export function reactToStatusTransitions(
  db: Database.Database,
  inDb: Database.Database,
  changes: StatusTransition[],
): void {
  if (changes.length === 0) return;
  const autoGen = getConfig<boolean>(db, 'interview_kit_auto_generate', true);
  for (const c of changes) {
    try {
      if (isTerminalStatus(c.to)) {
        void archiveKitsForApplication(db, c.application_id).catch((err) =>
          log.error('interview-kit archive on terminal transition failed', { applicationId: c.application_id, err }),
        );
        continue;
      }
      if (autoGen && isInterviewRoundStatus(c.to) && !hasActiveKit(db, c.application_id, c.to)) {
        enqueueKitWake(inDb, c.application_id, c.to);
      }
    } catch (err) {
      log.error('reactToStatusTransitions: one change failed', { change: c, err });
    }
  }
}
