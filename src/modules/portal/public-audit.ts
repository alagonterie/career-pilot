/**
 * src/modules/portal/public-audit.ts — Sub-milestone 4.1 mirror writer.
 *
 * `mirrorFunnelEvent(db, eventId)` reads a freshly-inserted funnel_events
 * row, joins to the originating application, runs the payload through the
 * sanitizer, applies a defense-in-depth check for surviving real company
 * names, and INSERTs a sanitized row into public_audit_trail.
 *
 * Called by `handleRecordFunnelEvent` AFTER `writeResponse` returns the
 * ok-frame to the container, so mirror latency never blocks the agent's
 * MCP call. All errors are logged and swallowed — public mirror is
 * best-effort. The private write is already committed by the time the
 * mirror runs.
 *
 * Categories beyond 'funnel' are deferred to Sub-milestone 4.2+.
 *
 * Sub-milestone 4.3 adds `resanitizeApplicationAuditTrail` (below): when an
 * application's obfuscation policy changes (public_state flip, or an edit to
 * obfuscated_label / company_name / company_aliases), the past audit rows
 * derived from that application's funnel_events are deleted and re-mirrored
 * from the still-canonical `funnel_events` truth. The link is
 * `public_audit_trail.source_funnel_event_id` (migration 122).
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

import { sanitize } from './sanitizer.js';

const DEFAULT_PUBLIC_SUMMARY_MAX_CHARS = 500;
const DEFAULT_AUDIT_DROP_ON_UNMATCHED_COMPANY = true;

function generateId(): string {
  return `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readNumberPref(db: Database.Database, key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    const parsed = parseInt(row.value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readBoolPref(db: Database.Database, key: string, fallback: boolean): boolean {
  try {
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    return row.value === 'true' || row.value === '1';
  } catch {
    return fallback;
  }
}

interface JoinedRow {
  // funnel_events
  id: string;
  application_id: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  payload: string;
  // applications (LEFT JOINed; null if missing)
  company_name: string | null;
  obfuscated_label: string | null;
  public_state: string | null;
}

/**
 * Outcome of a single mirror attempt. Returned so callers (notably
 * resanitizeApplicationAuditTrail) can count rows actually written vs
 * dropped by the defense-in-depth scan. handleRecordFunnelEvent ignores
 * the return — the mirror is best-effort there.
 */
export type MirrorOutcome = 'inserted' | 'dropped' | 'skipped' | 'error';

export function mirrorFunnelEvent(db: Database.Database, eventId: string): MirrorOutcome {
  let row: JoinedRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT fe.id, fe.application_id, fe.kind, fe.from_status, fe.to_status, fe.payload,
                a.company_name, a.obfuscated_label, a.public_state
           FROM funnel_events fe
           LEFT JOIN applications a ON fe.application_id = a.id
          WHERE fe.id = ?`,
      )
      .get(eventId) as JoinedRow | undefined;
  } catch (err) {
    log.error('mirrorFunnelEvent: load failed', { eventId, err });
    return 'error';
  }

  if (!row) {
    log.warn('mirrorFunnelEvent: funnel_event not found', { eventId });
    return 'skipped';
  }

  // application_id is NOT NULL on funnel_events (migration 101 FK), but the
  // LEFT JOIN can produce null application cols if the FK target is gone
  // (shouldn't happen given the constraint). Skip defensively.
  if (!row.application_id || !row.company_name) {
    return 'skipped';
  }

  const payloadText = `${row.kind} ${row.from_status ?? ''}→${row.to_status ?? ''} ${row.payload}`;
  const sanitized = sanitize(payloadText, { application_id: row.application_id, db });

  // Defense-in-depth: scan the sanitized text for any non-public real
  // company name. If something survived, drop the row rather than leak.
  // Operator can flip this off via sanitization_audit_drop_on_unmatched_company.
  const dropOnLeak = readBoolPref(
    db,
    'sanitization_audit_drop_on_unmatched_company',
    DEFAULT_AUDIT_DROP_ON_UNMATCHED_COMPANY,
  );
  if (dropOnLeak) {
    try {
      const nonPublic = db
        .prepare(`SELECT company_name FROM applications WHERE public_state != 'public' AND company_name != ''`)
        .all() as { company_name: string }[];
      const sanitizedLower = sanitized.toLowerCase();
      for (const { company_name } of nonPublic) {
        if (sanitizedLower.includes(company_name.toLowerCase())) {
          log.warn('mirrorFunnelEvent: real company name survived sanitization — dropping row', {
            eventId,
            leaked: company_name,
          });
          return 'dropped';
        }
      }
    } catch (err) {
      log.error('mirrorFunnelEvent: defense-in-depth scan failed', { eventId, err });
      // Continue — better to potentially leak than to silently fail closed
      // when the operator hasn't configured strict mode. (Toggle this
      // by setting sanitization_audit_drop_on_unmatched_company=false.)
    }
  }

  const maxChars = readNumberPref(db, 'sanitization_public_summary_max_chars', DEFAULT_PUBLIC_SUMMARY_MAX_CHARS);
  const summary = sanitized.length > maxChars ? sanitized.slice(0, maxChars) : sanitized;

  const applicationRef = row.public_state === 'public' ? row.company_name : (row.obfuscated_label ?? '');

  const details = JSON.stringify({
    kind: row.kind,
    from_status: row.from_status,
    to_status: row.to_status,
    sanitized,
  });

  try {
    db.prepare(
      `INSERT INTO public_audit_trail
         (id, seq, ts, category, application_ref, summary, details_json, source_funnel_event_id)
       VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail),
               @ts, @category, @application_ref, @summary, @details_json, @source_funnel_event_id)`,
    ).run({
      id: generateId(),
      ts: new Date().toISOString(),
      category: 'funnel',
      application_ref: applicationRef,
      summary,
      details_json: details,
      source_funnel_event_id: row.id,
    });
  } catch (err) {
    log.error('mirrorFunnelEvent: INSERT failed', { eventId, err });
    return 'error';
  }
  return 'inserted';
}

// ── Sub-milestone 4.3: retroactive resanitization ──────────────────────────

export interface ResanitizeResult {
  rewritten: number;
  deleted: number;
}

/**
 * Delete and re-mirror every funnel-category audit row derived from an
 * application's funnel_events. Call after the application's obfuscation
 * policy changes — a public_state flip, or an edit to obfuscated_label /
 * company_name / company_aliases — so the public rows reflect current
 * intent. Truth lives in funnel_events (never deleted); the audit trail is
 * a derived projection, so "rewriting history" here is intended.
 *
 * Runs in a single IMMEDIATE transaction. The host is the sole writer to
 * data/v2.db and better-sqlite3 is synchronous, so a concurrent mirror for
 * the same application cannot interleave mid-transaction; the IMMEDIATE
 * write lock makes that explicit and gives all-or-nothing atomicity (a
 * mid-run failure rolls back, leaving the prior rows intact).
 *
 * Defensive: never throws. On failure logs and returns { rewritten: 0,
 * deleted: 0 }. Callers (the handleUpdateApplication hook and the operator
 * script) treat a failed re-mirror as non-fatal — the application UPDATE is
 * already committed and funnel_events truth is untouched.
 *
 * Note: legacy audit rows with a NULL source_funnel_event_id (pre-migration
 * 122; none in practice) are NOT matched by the DELETE and are left as-is.
 */
export function resanitizeApplicationAuditTrail(db: Database.Database, applicationId: string): ResanitizeResult {
  const run = db.transaction((): ResanitizeResult => {
    const del = db
      .prepare(
        `DELETE FROM public_audit_trail
          WHERE category = 'funnel'
            AND source_funnel_event_id IN (
              SELECT id FROM funnel_events WHERE application_id = ?
            )`,
      )
      .run(applicationId);

    // Re-read inside the transaction so any event committed before our
    // BEGIN IMMEDIATE is visible; concurrent inserts serialize behind us.
    const events = db
      .prepare('SELECT id FROM funnel_events WHERE application_id = ? ORDER BY ts ASC')
      .all(applicationId) as Array<{ id: string }>;

    let rewritten = 0;
    for (const { id } of events) {
      if (mirrorFunnelEvent(db, id) === 'inserted') rewritten++;
    }
    return { rewritten, deleted: del.changes };
  });

  try {
    const result = run.immediate();
    log.info('resanitizeApplicationAuditTrail complete', {
      applicationId,
      rewritten: result.rewritten,
      deleted: result.deleted,
    });
    return result;
  } catch (err) {
    log.error('resanitizeApplicationAuditTrail failed', { applicationId, err });
    return { rewritten: 0, deleted: 0 };
  }
}
