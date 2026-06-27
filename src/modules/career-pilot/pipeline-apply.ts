/**
 * src/modules/career-pilot/pipeline-apply.ts — deterministic pipeline conversion.
 *
 * The pipeline-scribe classifies inbox mail into `email_events` (one row per
 * message, linked to an application). This module turns those classifications
 * into the candidate's pipeline board: for each application, the FURTHEST
 * classification it has received maps to an application status, which is written
 * to `applications.status` and projected into `public_pipeline_view`.
 *
 * Host-side + deterministic (no LLM, no approval gate) — "accurate
 * representation by default" (§24.43): the board reflects what recruiters
 * actually sent. Idempotent: only applications whose derived status differs are
 * touched. Invoked (a) after every non-cheap pipeline-scribe persist (so the
 * scheduled curator auto-converts), and (b) by the dev "Sweep & convert now"
 * button (to converge from already-classified mail without a re-fetch).
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import {
  type ApplicationStatus,
  APPLICATION_STATUSES,
  upsertPublicPipelineView,
} from '../portal/public-pipeline-view.js';

import { isTerminalStatus } from './interview-kit-store.js';

/**
 * Email classification → application status. Mirrors the recruiter progression
 * (confirmation → screen → onsite → next-round → offer) plus the two rejection
 * kinds. Unmapped classifications (e.g. `noise`) are ignored.
 */
const STATUS_BY_CLASSIFICATION: Record<string, ApplicationStatus> = {
  application_confirmation: 'APPLIED',
  screen_invite: 'SCREENING',
  onsite_invite: 'TECH_SCREEN',
  // `next_round_update` is the recruiter's explicit "advancing you to the final
  // round" signal. The scribe taxonomy reserves it for a genuine forward advance;
  // a vague "still reviewing" acknowledgment or a Google-Calendar cancellation
  // notice is `noise`, not this — so this mapping only fires on a real advance.
  next_round_update: 'FINAL',
  offer: 'OFFER',
  rejection: 'REJECTED',
  screen_rejection: 'REJECTED',
};

/**
 * Forward rank of a status on the canonical ladder (`APPLICATION_STATUSES`).
 * Unknown/empty → -1, so any real stage outranks it. Used by the monotonic
 * guard to forbid backward non-terminal moves.
 */
function statusRank(status: string): number {
  return APPLICATION_STATUSES.indexOf(status.toUpperCase() as ApplicationStatus);
}

export interface PipelineApplyChange {
  application_id: string;
  from: string;
  to: ApplicationStatus;
}

export interface PipelineApplyResult {
  converted: number;
  changes: PipelineApplyChange[];
}

/**
 * Converge each application's status to the furthest mapped classification in
 * `email_events`, then refresh `public_pipeline_view`. Returns the applied
 * changes. Never throws — a failure for one application is logged and skipped.
 */
export function applyPipelineFromEmailEvents(db: Database.Database): PipelineApplyResult {
  // Rows ASC by received_at: the LAST write into the map per app wins, i.e. the
  // most recent email that maps to a pipeline status (a later rejection beats an
  // earlier onsite; trailing `noise` is skipped, leaving the prior real stage).
  let rows: Array<{ app_id: string; classification: string }>;
  try {
    rows = db
      .prepare(
        `SELECT linked_application_id AS app_id, classification
           FROM email_events
          WHERE linked_application_id IS NOT NULL
          ORDER BY received_at ASC`,
      )
      .all() as Array<{ app_id: string; classification: string }>;
  } catch (err) {
    log.error('applyPipelineFromEmailEvents: email_events read failed', { err });
    return { converted: 0, changes: [] };
  }

  const target = new Map<string, ApplicationStatus>();
  for (const r of rows) {
    const status = STATUS_BY_CLASSIFICATION[r.classification];
    if (status) target.set(r.app_id, status);
  }

  const changes: PipelineApplyChange[] = [];
  for (const [appId, status] of target) {
    try {
      const cur = db.prepare('SELECT status FROM applications WHERE id = ?').get(appId) as
        | { status: string | null }
        | undefined;
      if (!cur) continue; // no such application
      const curStatus = (cur.status ?? '').toUpperCase();
      if (curStatus === status) continue; // already there

      // Monotonic guard (§24.181). The "latest-mapped-email wins" rule above is
      // intentional for terminal signals — a later rejection/offer legitimately
      // closes an interviewing app, so terminal targets always apply. But a
      // NON-terminal classification must never move an app backward (a stray or
      // late `screen_invite` can't revert an agent-set `TECH_SCREEN`) nor
      // resurrect a terminal app (a `screen_invite` can't un-reject). Without
      // this, a single mis- or late-classified email yo-yos the board.
      if (!isTerminalStatus(status)) {
        if (isTerminalStatus(curStatus)) continue; // never un-terminal
        if (statusRank(status) <= statusRank(curStatus)) continue; // forward-only
      }

      db.prepare("UPDATE applications SET status = ?, last_activity_at = datetime('now') WHERE id = ?").run(
        status,
        appId,
      );
      upsertPublicPipelineView(db, appId);
      changes.push({ application_id: appId, from: cur.status ?? '', to: status });
    } catch (err) {
      log.error('applyPipelineFromEmailEvents: failed to convert one application', { appId, status, err });
    }
  }

  if (changes.length > 0) {
    log.info('applyPipelineFromEmailEvents: board converged from email_events', { converted: changes.length });
  }
  return { converted: changes.length, changes };
}
