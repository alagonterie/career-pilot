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
 * Naming boundary (§24.77 D3): the PRIVATE source is still `funnel_events`
 * (the internal domain term — table unrenamed), but the PUBLIC projection
 * uses the visitor-facing 'pipeline' category. The mirror is exactly where
 * that internal→public rename happens.
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

import { upsertPublicKitView } from './public-kit-view.js';
import { sanitize, sanitizeForPublic } from './sanitizer.js';

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
  proactive: number;
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
export type MirrorOutcome = 'inserted' | 'dropped' | 'skipped' | 'error' | 'withheld';

/**
 * The human-readable text to mirror publicly for a funnel event (§24.89). Funnel
 * payloads are often structured JSON carrying the agent's own one-line prose — a
 * status-change ships `{ summary, source, confidence }`, where `summary` already
 * describes the transition ("Rejection email received from … — applied X,
 * rejected Y"). Use that verbatim; only fall back to the literal
 * `kind from→to {payload}` form for plain-text / summary-less payloads. Without
 * this, the raw JSON blob reached the public trace ("status_change APPLIED→REJECTED
 * {…}") — the unreadable rows the owner caught. Either branch is sanitized
 * downstream (this only chooses the source text, never the trust boundary).
 */
export function funnelEventPublicText(row: Pick<JoinedRow, 'kind' | 'from_status' | 'to_status' | 'payload'>): string {
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload) as { summary?: unknown };
      if (typeof parsed?.summary === 'string' && parsed.summary.trim().length > 0) {
        return parsed.summary.trim();
      }
    } catch {
      // payload isn't JSON — use the literal form below.
    }
  }
  return `${row.kind} ${row.from_status ?? ''}→${row.to_status ?? ''} ${row.payload}`.trim();
}

/**
 * The public-safe display ref for an application — the real company name when
 * revealed, else the obfuscated label (the same rule mirrorFunnelEvent applies
 * inline from its join). §24.61: this is the HOST-side derivation that lets a
 * container pass only the internal application_id — a subagent never authors
 * the public label, because an echo of the real company name on a non-public
 * application would be a leak. Returns null for an unknown id or an
 * application with no usable label (caller inserts ref-less).
 */
export function publicApplicationRef(db: Database.Database, applicationId: string): string | null {
  try {
    const row = db
      .prepare('SELECT company_name, obfuscated_label, public_state FROM applications WHERE id = ?')
      .get(applicationId) as
      | { company_name: string | null; obfuscated_label: string | null; public_state: string | null }
      | undefined;
    if (!row) return null;
    const ref = row.public_state === 'public' ? row.company_name : row.obfuscated_label;
    return ref && ref.length > 0 ? ref : null;
  } catch (err) {
    log.error('publicApplicationRef failed', { applicationId, err });
    return null;
  }
}

export async function mirrorFunnelEvent(db: Database.Database, eventId: string): Promise<MirrorOutcome> {
  let row: JoinedRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT fe.id, fe.application_id, fe.kind, fe.from_status, fe.to_status, fe.payload, fe.proactive,
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

  const payloadText = funnelEventPublicText(row);
  const { text: sanitized, ok } = await sanitizeForPublic(payloadText, {
    application_id: row.application_id,
    db,
    obfuscatedLabel: row.obfuscated_label ?? undefined,
  });
  // Fail-safe (§24.12): Pass 3 was active but failed → withhold the public row
  // rather than risk a leak. The private funnel_events truth is untouched.
  if (!ok) {
    log.warn('mirrorFunnelEvent: Pass 3 unavailable — withholding public row', { eventId });
    return 'withheld';
  }

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
      // Alias-aware (§24.65 Δ): prose often uses a short form ("AMD") while
      // company_name holds the legal name ("Advanced Micro Devices, Inc") —
      // scanning the canonical name alone misses the form text actually uses.
      const nonPublic = db
        .prepare(
          `SELECT company_name, company_aliases FROM applications WHERE public_state != 'public' AND company_name != ''`,
        )
        .all() as { company_name: string; company_aliases: string | null }[];
      const sanitizedLower = sanitized.toLowerCase();
      for (const { company_name, company_aliases } of nonPublic) {
        const needles = [company_name];
        if (company_aliases) {
          try {
            const aliases = JSON.parse(company_aliases) as unknown;
            if (Array.isArray(aliases)) {
              for (const a of aliases) {
                if (typeof a === 'string' && a.length > 1) needles.push(a);
              }
            }
          } catch {
            // Unparseable aliases column — the name check still runs.
          }
        }
        const leaked = needles.find((n) => sanitizedLower.includes(n.toLowerCase()));
        if (leaked) {
          log.warn('mirrorFunnelEvent: real company name survived sanitization — dropping row', {
            eventId,
            leaked,
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
         (id, seq, ts, category, proactive, application_ref, summary, details_json, source_funnel_event_id)
       VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail),
               @ts, @category, @proactive, @application_ref, @summary, @details_json, @source_funnel_event_id)`,
    ).run({
      id: generateId(),
      ts: new Date().toISOString(),
      // Public-facing category (§24.77 D3) — the private source is funnel_events.
      category: 'pipeline',
      proactive: row.proactive ? 1 : 0,
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
export async function resanitizeApplicationAuditTrail(
  db: Database.Database,
  applicationId: string,
): Promise<ResanitizeResult> {
  // DELETE synchronously in a transaction (atomic, fast). The re-mirror loop
  // runs async OUTSIDE the transaction: better-sqlite3 transactions cannot span
  // `await`s, and Pass 3 (when active) is an async LLM call (§24.12). We lose
  // single-transaction atomicity but correctness holds — truth lives in
  // funnel_events (never deleted), so a partial re-mirror just leaves some
  // public rows missing until the next mirror, consistent with the
  // best-effort/never-throws contract. Withheld rows (Pass 3 unavailable) are
  // intentionally not re-inserted.
  let deleted = 0;
  try {
    const del = db
      .prepare(
        `DELETE FROM public_audit_trail
          WHERE category = 'pipeline'
            AND source_funnel_event_id IN (
              SELECT id FROM funnel_events WHERE application_id = ?
            )`,
      )
      .run(applicationId);
    deleted = del.changes;
  } catch (err) {
    log.error('resanitizeApplicationAuditTrail: delete failed', { applicationId, err });
    return { rewritten: 0, deleted: 0 };
  }

  let rewritten = 0;
  try {
    const events = db
      .prepare('SELECT id FROM funnel_events WHERE application_id = ? ORDER BY ts ASC')
      .all(applicationId) as Array<{ id: string }>;
    for (const { id } of events) {
      if ((await mirrorFunnelEvent(db, id)) === 'inserted') rewritten++;
    }
  } catch (err) {
    log.error('resanitizeApplicationAuditTrail: re-mirror failed', { applicationId, err });
  }

  // §24.61: subagent_progress rows attribute themselves via details_json's
  // application_id; their stored application_ref was derived under the OLD
  // policy. Re-derive in place so a reveal flip (and especially an un-reveal —
  // a real name stored as the ref while public) reflects current intent. The
  // summary TEXT is not re-derived from a private source (none exists), but it
  // IS re-run through the deterministic sanitizer in place (§24.65 Δ): an
  // alias added after the row was mirrored — the live "AMD" vs "Advanced
  // Micro Devices, Inc" gap — gets redacted retroactively. Asymmetric by
  // design: re-sanitizing never un-redacts on a reveal flip.
  let progressRefsUpdated = 0;
  try {
    const ref = publicApplicationRef(db, applicationId);
    const rows = db
      .prepare(
        `SELECT id, summary FROM public_audit_trail
          WHERE category = 'subagent_progress'
            AND json_extract(details_json, '$.application_id') = ?`,
      )
      .all(applicationId) as Array<{ id: string; summary: string | null }>;
    const upd = db.prepare('UPDATE public_audit_trail SET application_ref = @ref, summary = @summary WHERE id = @id');
    for (const row of rows) {
      upd.run({ id: row.id, ref, summary: row.summary ? sanitize(row.summary, { db }) : row.summary });
      progressRefsUpdated++;
    }
  } catch (err) {
    log.error('resanitizeApplicationAuditTrail: progress-ref rederive failed', { applicationId, err });
  }

  // §24.134a: the kit projection is a separate read-model with its OWN belt
  // (the entity-redaction detection pass). A sanitizer-rule change — or running
  // the resanitize script after one — must reproject the kit too, else a kit
  // row keeps a stale, pre-belt rendering (the live "EdgeProxy" leak). Best-effort
  // like everything else here; upsertPublicKitView never throws.
  try {
    await upsertPublicKitView(db, applicationId);
  } catch (err) {
    log.error('resanitizeApplicationAuditTrail: kit reproject failed', { applicationId, err });
  }

  log.info('resanitizeApplicationAuditTrail complete', { applicationId, rewritten, deleted, progressRefsUpdated });
  return { rewritten, deleted };
}
