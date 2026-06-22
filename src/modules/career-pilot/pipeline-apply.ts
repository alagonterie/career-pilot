/**
 * src/modules/career-pilot/funnel-apply.ts — deterministic funnel conversion.
 *
 * The funnel-curator classifies inbox mail into `email_events` (one row per
 * message, linked to an application). This module turns those classifications
 * into the candidate's funnel board: for each application, the FURTHEST
 * classification it has received maps to an application status, which is written
 * to `applications.status` and projected into `public_funnel_view`.
 *
 * Host-side + deterministic (no LLM, no approval gate) — "accurate
 * representation by default" (§24.43): the board reflects what recruiters
 * actually sent. Idempotent: only applications whose derived status differs are
 * touched. Invoked (a) after every non-cheap funnel-curator persist (so the
 * scheduled curator auto-converts), and (b) by the dev "Sweep & convert now"
 * button (to converge from already-classified mail without a re-fetch).
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { type ApplicationStatus, upsertPublicFunnelView } from '../portal/public-funnel-view.js';

/**
 * Email classification → application status. Mirrors the recruiter progression
 * (confirmation → screen → onsite → next-round → offer) plus the two rejection
 * kinds. Unmapped classifications (e.g. `noise`) are ignored.
 */
const STATUS_BY_CLASSIFICATION: Record<string, ApplicationStatus> = {
  application_confirmation: 'APPLIED',
  screen_invite: 'SCREENING',
  onsite_invite: 'TECH_SCREEN',
  next_round_update: 'FINAL',
  offer: 'OFFER',
  rejection: 'REJECTED',
  screen_rejection: 'REJECTED',
};

export interface FunnelApplyChange {
  application_id: string;
  from: string;
  to: ApplicationStatus;
}

export interface FunnelApplyResult {
  converted: number;
  changes: FunnelApplyChange[];
}

/**
 * Converge each application's status to the furthest mapped classification in
 * `email_events`, then refresh `public_funnel_view`. Returns the applied
 * changes. Never throws — a failure for one application is logged and skipped.
 */
export function applyFunnelFromEmailEvents(db: Database.Database): FunnelApplyResult {
  // Rows ASC by received_at: the LAST write into the map per app wins, i.e. the
  // most recent email that maps to a funnel status (a later rejection beats an
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
    log.error('applyFunnelFromEmailEvents: email_events read failed', { err });
    return { converted: 0, changes: [] };
  }

  const target = new Map<string, ApplicationStatus>();
  for (const r of rows) {
    const status = STATUS_BY_CLASSIFICATION[r.classification];
    if (status) target.set(r.app_id, status);
  }

  const changes: FunnelApplyChange[] = [];
  for (const [appId, status] of target) {
    try {
      const cur = db.prepare('SELECT status FROM applications WHERE id = ?').get(appId) as
        | { status: string | null }
        | undefined;
      if (!cur) continue; // no such application
      if ((cur.status ?? '').toUpperCase() === status) continue; // already there
      db.prepare("UPDATE applications SET status = ?, last_activity_at = datetime('now') WHERE id = ?").run(
        status,
        appId,
      );
      upsertPublicFunnelView(db, appId);
      changes.push({ application_id: appId, from: cur.status ?? '', to: status });
    } catch (err) {
      log.error('applyFunnelFromEmailEvents: failed to convert one application', { appId, status, err });
    }
  }

  if (changes.length > 0) {
    log.info('applyFunnelFromEmailEvents: board converged from email_events', { converted: changes.length });
  }
  return { converted: changes.length, changes };
}
