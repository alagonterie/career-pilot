/**
 * Interview-kit status-transition trigger (STRATEGY.md §24.53).
 *
 * The seam that turns "an interview now exists" into a kit. Called from the two
 * places application status transitions:
 *   - the deterministic converter (`applyPipelineFromEmailEvents` → its `changes[]`,
 *     invoked from `handlePersistPipelineState`), the primary path the recruiter-sim
 *     exercises; and
 *   - the agent-driven `handleUpdateApplication` path.
 *
 * On entry to an interview stage → enqueue a ONE-OFF `[scheduled trigger:
 * build-interview-kit]` wake (the orchestrator does the LLM work next turn); on
 * entry to a terminal stage → archive the application's active kits. Synchronous +
 * defensive (one bad change never blocks the others or the caller).
 */
import type Database from 'better-sqlite3';

import { hasTable } from '../../db/connection.js';
import { nextEvenSeq } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

import { promoteBoardForAppliedLead } from './ats-watchlist.js';
import { archiveKitsForApplication } from './interview-kit-actions.js';
import { hasActiveKit, isInterviewRoundStatus, isTerminalStatus } from './interview-kit-store.js';
import { promoteLeadOnApplied } from './lead-promotion.js';

/**
 * A status transition to react to. Structurally a superset of
 * `pipeline-apply.ts`'s `PipelineApplyChange` (so its `changes[]` is assignable) and
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

function pendingKitWakeId(inDb: Database.Database, seriesId: string): string | null {
  const row = inDb
    .prepare(
      "SELECT id FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused') LIMIT 1",
    )
    .get(seriesId) as { id: string } | undefined;
  return row?.id ?? null;
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
  return enqueueKitWakeTask(inDb, applicationId, round).inserted;
}

/**
 * Same as `enqueueKitWake`, returning the task row's id — the inserted row, or
 * the already-pending wake it deduped onto. The `/admin` *Build interview kit*
 * action (§24.203 D3) records it so it can observe that task's acknowledgement.
 */
export function enqueueKitWakeTask(
  inDb: Database.Database,
  applicationId: string,
  round: string,
): { id: string; inserted: boolean } {
  const seriesId = kitWakeSeriesId(applicationId, round);
  const pending = pendingKitWakeId(inDb, seriesId);
  if (pending) return { id: pending, inserted: false };
  const id = generateTaskId();
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (@id, @seq, datetime('now'), 'pending', 0, datetime('now'), NULL, 'task', NULL, NULL, NULL, @content, @seriesId)`,
    )
    .run({
      id,
      seq: nextEvenSeq(inDb),
      content: JSON.stringify({ prompt: buildKitWakePrompt(applicationId, round) }),
      seriesId,
    });
  log.info('interview-kit wake enqueued', { applicationId, round, seriesId });
  return { id, inserted: true };
}

/**
 * The trigger deduped its kit wake onto `messageId`. When that wake belongs to
 * an `/admin` *Build interview kit* action still in flight, the trigger now
 * relies on it too: the action no longer owns it alone, so the action's expiry
 * must leave it queued (`agent_actions.owns_task = 0`). Never throws.
 */
export function releaseSharedActionTask(db: Database.Database, messageId: string): void {
  try {
    if (!hasTable(db, 'agent_actions')) return;
    db.prepare("UPDATE agent_actions SET owns_task = 0 WHERE message_id = ? AND status IN ('queued', 'running')").run(
      messageId,
    );
  } catch (err) {
    log.warn('interview-kit wake: could not mark an admin action’s wake as shared', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * React to a batch of status transitions. On entry to a submitted stage → promote
 * the originating lead (§24.175, link + flip to `applied`). On entry to an interview
 * stage → enqueue a kit wake (unless auto-gen is off or an active kit already exists
 * for that round). On entry to a terminal stage → archive the application's active
 * kits (fire-and-forget; it touches Drive). Never throws.
 *
 * `inDb` is the session inbound DB the kit wake is written to. It is only needed
 * for an interview-round transition; a caller with no agent session (the
 * `/admin` "I applied" action, §24.202 D8 — always a transition to APPLIED)
 * passes null, and an interview-round change then logs and skips the wake
 * instead of failing.
 */
export function reactToStatusTransitions(
  db: Database.Database,
  inDb: Database.Database | null,
  changes: StatusTransition[],
): void {
  if (changes.length === 0) return;
  const autoGen = getConfig<boolean>(db, 'interview_kit_auto_generate', true);
  for (const c of changes) {
    try {
      // §24.175: a transition into a submitted stage promotes the originating
      // lead (link + flip to `applied`). No-op for non-submitted transitions.
      // §24.195: an application with no discovered lead gets a synthesized one.
      const promoted = promoteLeadOnApplied(db, c, { createIfMissing: true });
      // §24.201 D7 owner signal, on the agent path too: an application linked
      // to a lead here promotes that lead's board (added as 'applied', or its
      // tier raised). Only when THIS call linked it — the /admin "I applied"
      // action links first and promotes the board itself, so it is never
      // promoted twice. A rejection is not a reason to watch a board more.
      // Best-effort; never throws.
      if (promoted && String(c.to).toUpperCase() !== 'REJECTED') {
        promoteBoardForAppliedLead(db, promoted.leadId);
      }
      if (isTerminalStatus(c.to)) {
        void archiveKitsForApplication(db, c.application_id).catch((err) =>
          log.error('interview-kit archive on terminal transition failed', { applicationId: c.application_id, err }),
        );
        continue;
      }
      if (autoGen && isInterviewRoundStatus(c.to) && !hasActiveKit(db, c.application_id, c.to)) {
        if (inDb) {
          const wake = enqueueKitWakeTask(inDb, c.application_id, c.to);
          if (!wake.inserted) releaseSharedActionTask(db, wake.id);
        } else log.warn('interview-kit wake skipped: no session inbound DB for this caller', { change: c });
      }
    } catch (err) {
      log.error('reactToStatusTransitions: one change failed', { change: c, err });
    }
  }
}
