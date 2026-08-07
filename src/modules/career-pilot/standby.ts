/**
 * src/modules/career-pilot/standby.ts — the box-side half of standby (§24.189).
 *
 * Standby stops the VM for weeks at a time. The edge owns the public switch and
 * the resume button; this module owns the two things that can only be done on the
 * box: freezing the host cleanly on the way down, and making sure the way back up
 * doesn't detonate a pile of stale proactive work.
 *
 * The stampede is real but bounded, and worth stating precisely because it drives
 * the fix. `handleRecurrence` keeps exactly ONE pending row per recurring series
 * (it inserts the next occurrence and clears the completed row's recurrence), and
 * it refuses to advance any chain while `pause_state !== 'active'`. So a two-month
 * standby does NOT accumulate one row per missed day — but every series' single
 * pending row ends up far overdue, and the instant `/resume` lands they are all
 * due at once: the morning briefing, the scrape and the scribe pass firing
 * together in the middle of an afternoon.
 *
 * So `prepareResume` rolls each overdue row forward to its NEXT cron occurrence
 * from now. Occurrences that fell during the pause are skipped, not replayed —
 * they describe days that did not happen, and a briefing about them would be
 * fiction.
 */
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';

/** A pending scheduled row that is due (or overdue) as of `nowIso`. */
interface DueRow {
  id: string;
  recurrence: string | null;
  process_after: string | null;
}

export interface ResumePrepResult {
  /** Rows whose process_after was moved forward to their next occurrence. */
  rescheduled: number;
  /** Overdue rows with no recurrence (one-shots) — left alone, reported. */
  oneShotsLeft: number;
  /** Rows whose cron expression could not be parsed (left alone). */
  unparseable: number;
}

/**
 * Roll every overdue PENDING recurring row forward to its next occurrence.
 *
 * One-shot rows (no `recurrence`) are deliberately NOT touched: a scheduled
 * one-off is a thing the owner asked for once, and silently moving or dropping it
 * would lose intent. They're counted and reported so the operator can decide.
 *
 * Pure-ish + dependency-injected `now` so the rescheduling is unit-testable
 * without waiting for a clock.
 */
export async function prepareResume(db: Database.Database, now: Date = new Date()): Promise<ResumePrepResult> {
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT id, recurrence, process_after
         FROM messages_in
        WHERE status = 'pending'
          AND process_after IS NOT NULL
          AND process_after <= ?`,
    )
    .all(nowIso) as DueRow[];

  const result: ResumePrepResult = { rescheduled: 0, oneShotsLeft: 0, unparseable: 0 };
  if (rows.length === 0) return result;

  // Dynamic-imported exactly as handleRecurrence does (the project is ESM — a
  // bare `require` here would throw on the box). Resolved BEFORE the transaction,
  // since a better-sqlite3 transaction body must stay synchronous.
  const { CronExpressionParser } = await import('cron-parser');

  const update = db.prepare(`UPDATE messages_in SET process_after = @next WHERE id = @id`);
  db.transaction(() => {
    for (const row of rows) {
      if (!row.recurrence) {
        result.oneShotsLeft += 1;
        continue;
      }
      try {
        // Interpret in the owner's timezone, exactly as handleRecurrence does —
        // otherwise a "0 7 * * *" briefing would be rescheduled to 07:00 UTC.
        const interval = CronExpressionParser.parse(row.recurrence, { tz: TIMEZONE, currentDate: now });
        update.run({ id: row.id, next: interval.next().toISOString() });
        result.rescheduled += 1;
      } catch (err) {
        // A row we can't reschedule is left due rather than dropped — firing one
        // stale job is recoverable; silently deleting the owner's schedule is not.
        log.error('standby resume: could not parse recurrence, leaving row due', {
          messageId: row.id,
          recurrence: row.recurrence,
          err,
        });
        result.unparseable += 1;
      }
    }
  })();

  log.info('standby resume: overdue proactive work rolled forward', { ...result });
  return result;
}
