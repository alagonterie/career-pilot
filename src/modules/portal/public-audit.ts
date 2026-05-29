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
    const row = db
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (!row) return fallback;
    const parsed = parseInt(row.value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readBoolPref(db: Database.Database, key: string, fallback: boolean): boolean {
  try {
    const row = db
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(key) as { value: string } | undefined;
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
        .prepare(
          `SELECT company_name FROM applications WHERE public_state != 'public' AND company_name != ''`,
        )
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

  const maxChars = readNumberPref(
    db,
    'sanitization_public_summary_max_chars',
    DEFAULT_PUBLIC_SUMMARY_MAX_CHARS,
  );
  const summary = sanitized.length > maxChars ? sanitized.slice(0, maxChars) : sanitized;

  const applicationRef =
    row.public_state === 'public' ? row.company_name : row.obfuscated_label ?? '';

  const details = JSON.stringify({
    kind: row.kind,
    from_status: row.from_status,
    to_status: row.to_status,
    sanitized,
  });

  try {
    db.prepare(
      `INSERT INTO public_audit_trail
         (id, ts, category, application_ref, summary, details_json, source_funnel_event_id)
       VALUES (@id, @ts, @category, @application_ref, @summary, @details_json, @source_funnel_event_id)`,
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
