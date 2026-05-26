/**
 * Career-pilot delivery action handlers (host side).
 *
 * The container's MCP tools cannot write to `data/v2.db` (the host's
 * long-lived WAL connection precludes cross-mount writes). The contract,
 * per STRATEGY.md §6.1:
 *
 *   1. Container writes `kind: 'system'` to outbound.db with
 *      `{ action: 'career_pilot.<verb>', requestId, payload }`.
 *   2. Host's delivery sweep dispatches via this module's registered
 *      handlers (see `index.ts` for the `registerDeliveryAction` calls).
 *   3. Handler applies the DB op against the central `data/v2.db`
 *      (`getDb()`), writes a response back to the session's inbound.db.
 *   4. Container's `sendAction` helper polls inbound.db for the response.
 *
 * Response shape (parsed by `container/agent-runner/src/career-pilot/action.ts`):
 *   { type: 'career_pilot_response', requestId, frame: { ok: true, data } | { ok: false, error: { code, message } } }
 *
 * All handlers MUST write a response — leaving the container blocked on a
 * timeout when the host actually saw the request is the worst-of-both-
 * worlds failure mode.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

// ── Response writer (shared by all handlers) ──

type ActionFrame =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

function writeResponse(inDb: Database.Database, requestId: string, frame: ActionFrame): void {
  insertMessage(inDb, {
    id: `cp-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'career_pilot_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0, // response should not wake the agent
  });
}

function reqId(content: Record<string, unknown>): string {
  return (content.requestId as string) || 'unknown';
}

function payload(content: Record<string, unknown>): Record<string, unknown> {
  return (content.payload as Record<string, unknown>) ?? {};
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── update_profile_field ───────────────────────────────────────────────────

const PROFILE_FIELDS = new Set([
  'full_name',
  'display_name',
  'bio',
  'target_roles',
  'location_pref',
  'comp_floor',
  'master_resume',
  'skills',
  'github_url',
  'linkedin_url',
  'x_url',
  'website_url',
  'why_this_exists',
  'headshot_path',
  'brand_color_hsl',
]);

export async function handleUpdateProfileField(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const field = p.field as string;
  const value = p.value;

  if (!field || !PROFILE_FIELDS.has(field)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_FIELD', message: `unknown field "${field}"` },
    });
    return;
  }

  const now = new Date().toISOString();
  try {
    const db = getDb();
    // INSERT OR REPLACE the single-row table: we always want a row with id=1
    // even if the previous turn was the very first update.
    db.prepare(
      `INSERT INTO candidate_profile (id, updated_at) VALUES (1, @updated_at)
       ON CONFLICT(id) DO NOTHING`,
    ).run({ updated_at: now });

    db.prepare(`UPDATE candidate_profile SET ${field} = @value, updated_at = @updated_at WHERE id = 1`).run({
      value: value === undefined ? null : value,
      updated_at: now,
    });

    log.info('candidate_profile updated', { field });
    writeResponse(inDb, requestId, { ok: true, data: { field } });
  } catch (err) {
    log.error('handleUpdateProfileField failed', { field, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── update_application (UPSERT) ────────────────────────────────────────────

const APPLICATION_COLUMNS = [
  'company_name',
  'company_aliases',
  'obfuscated_label',
  'public_state',
  'role_title',
  'job_url',
  'jd_text',
  'jd_analyzed',
  'status',
  'win_confidence',
  'applied_at',
  'last_activity_at',
] as const;

const INSERT_REQUIRED = ['company_name', 'role_title', 'status'] as const;

export async function handleUpdateApplication(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const id = p.id as string;
  const patch = (p.patch as Record<string, unknown>) ?? {};

  if (!id) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: 'id is required' } });
    return;
  }

  try {
    const db = getDb();
    const existing = db.prepare('SELECT obfuscated_label FROM applications WHERE id = ?').get(id) as
      | { obfuscated_label: string }
      | undefined;

    const now = new Date().toISOString();

    if (!existing) {
      // INSERT branch
      const missing = INSERT_REQUIRED.filter((k) => !patch[k]);
      if (missing.length > 0) {
        writeResponse(inDb, requestId, {
          ok: false,
          error: {
            code: 'BAD_ARGS',
            message: `INSERT requires fields: ${missing.join(', ')}`,
          },
        });
        return;
      }

      const industry = deriveIndustry(patch);
      const obfuscated_label = nextObfuscatedLabel(industry);

      db.prepare(
        `INSERT INTO applications (
          id, company_name, company_aliases, obfuscated_label, public_state,
          role_title, job_url, jd_text, jd_analyzed, status, win_confidence,
          applied_at, last_activity_at, created_at
        ) VALUES (
          @id, @company_name, @company_aliases, @obfuscated_label, @public_state,
          @role_title, @job_url, @jd_text, @jd_analyzed, @status, @win_confidence,
          @applied_at, @last_activity_at, @created_at
        )`,
      ).run({
        id,
        company_name: patch.company_name ?? null,
        company_aliases: patch.company_aliases ?? null,
        obfuscated_label,
        public_state: patch.public_state ?? 'obfuscated',
        role_title: patch.role_title ?? null,
        job_url: patch.job_url ?? null,
        jd_text: patch.jd_text ?? null,
        jd_analyzed: patch.jd_analyzed ?? null,
        status: patch.status ?? null,
        win_confidence: patch.win_confidence ?? null,
        applied_at: patch.applied_at ?? null,
        last_activity_at: now,
        created_at: now,
      });

      log.info('Application created', { id, obfuscated_label });
      writeResponse(inDb, requestId, {
        ok: true,
        data: { id, created: true, obfuscated_label },
      });
      return;
    }

    // UPDATE branch — only fields present in patch
    const updatable = APPLICATION_COLUMNS.filter(
      (k) => k !== 'obfuscated_label' && Object.prototype.hasOwnProperty.call(patch, k),
    );
    if (updatable.length === 0) {
      // No-op update — still bump last_activity_at and respond OK.
      db.prepare('UPDATE applications SET last_activity_at = @now WHERE id = @id').run({ id, now });
      writeResponse(inDb, requestId, {
        ok: true,
        data: { id, created: false, obfuscated_label: existing.obfuscated_label },
      });
      return;
    }

    const setClause = updatable.map((k) => `${k} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id, last_activity_at: now };
    for (const k of updatable) {
      params[k] = patch[k] ?? null;
    }
    db.prepare(`UPDATE applications SET ${setClause}, last_activity_at = @last_activity_at WHERE id = @id`).run(
      params,
    );

    log.info('Application updated', { id, fields: updatable });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { id, created: false, obfuscated_label: existing.obfuscated_label },
    });
  } catch (err) {
    log.error('handleUpdateApplication failed', { id, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Derive an industry slug for the obfuscated_label. Phase 1 has no
 * analyze_jd, so we accept industry from patch.jd_analyzed.role_category
 * if present, otherwise fall back to 'misc'. Industry-aware labelling
 * matures in Phase 2 when analyze_jd lands.
 */
function deriveIndustry(patch: Record<string, unknown>): string {
  try {
    if (typeof patch.jd_analyzed === 'string') {
      const parsed = JSON.parse(patch.jd_analyzed) as { role_category?: string };
      if (parsed.role_category) return slugify(parsed.role_category);
    }
  } catch {
    /* ignore */
  }
  return 'misc';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'misc';
}

/**
 * Generate the next obfuscated_label for an industry: industry-a, industry-b,
 * ... industry-z, industry-aa, industry-ab, ... Deterministic for a given
 * existing-label set, so independent callers concurrent on the same industry
 * are not safe — but UPSERTs are serialized through the host's single-writer
 * connection so we don't worry about it.
 */
function nextObfuscatedLabel(industry: string): string {
  const rows = getDb()
    .prepare('SELECT obfuscated_label FROM applications WHERE obfuscated_label LIKE ?')
    .all(`${industry}-%`) as Array<{ obfuscated_label: string }>;
  const used = new Set(rows.map((r) => r.obfuscated_label.split(/-(.+)/)[1]).filter(Boolean));
  let n = 0;
  while (true) {
    const suffix = encodeSuffix(n);
    if (!used.has(suffix)) return `${industry}-${suffix}`;
    n++;
  }
}

/** 0 → 'a', 1 → 'b', ..., 25 → 'z', 26 → 'aa', 27 → 'ab', ... */
function encodeSuffix(n: number): string {
  let s = '';
  n = Math.max(0, Math.floor(n));
  while (true) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    if (n < 26) return s;
    n = Math.floor(n / 26) - 1;
  }
}

// ── record_funnel_event ────────────────────────────────────────────────────

export async function handleRecordFunnelEvent(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const application_id = p.application_id as string;
  const kind = p.kind as string;
  const payloadJson = p.payload as Record<string, unknown> | undefined;
  const from_status = (p.from_status as string | null) ?? null;
  const to_status = (p.to_status as string | null) ?? null;

  if (!application_id || !kind || !payloadJson) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'application_id, kind, and payload are required' },
    });
    return;
  }

  try {
    const db = getDb();
    const appExists = db.prepare('SELECT 1 FROM applications WHERE id = ?').get(application_id);
    if (!appExists) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: { code: 'NOT_FOUND', message: `no application with id "${application_id}"` },
      });
      return;
    }

    const event_id = generateId('fe');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO funnel_events
         (id, application_id, kind, from_status, to_status, payload, source, ts)
       VALUES (@id, @application_id, @kind, @from_status, @to_status, @payload, 'agent', @ts)`,
    ).run({
      id: event_id,
      application_id,
      kind,
      from_status,
      to_status,
      payload: JSON.stringify(payloadJson),
      ts: now,
    });
    // Bump the application's last_activity_at to match.
    db.prepare('UPDATE applications SET last_activity_at = @ts WHERE id = @id').run({
      id: application_id,
      ts: now,
    });

    log.info('Funnel event recorded', { event_id, application_id, kind });
    writeResponse(inDb, requestId, { ok: true, data: { event_id } });
  } catch (err) {
    log.error('handleRecordFunnelEvent failed', { application_id, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── get_application ────────────────────────────────────────────────────────

export async function handleGetApplication(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const id = p.id as string;

  if (!id) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: 'id is required' } });
    return;
  }

  try {
    const row = getDb().prepare('SELECT * FROM applications WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    writeResponse(inDb, requestId, { ok: true, data: { application: row ?? null } });
  } catch (err) {
    log.error('handleGetApplication failed', { id, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── list_applications ──────────────────────────────────────────────────────

export async function handleListApplications(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const status = p.status as string | null;
  const limitRaw = p.limit as number | null;
  const limit = limitRaw && limitRaw > 0 && limitRaw <= 200 ? Math.floor(limitRaw) : 50;

  try {
    let rows: Array<Record<string, unknown>>;
    if (status) {
      rows = getDb()
        .prepare(
          'SELECT * FROM applications WHERE status = ? ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?',
        )
        .all(status, limit) as Array<Record<string, unknown>>;
    } else {
      rows = getDb()
        .prepare(
          'SELECT * FROM applications ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?',
        )
        .all(limit) as Array<Record<string, unknown>>;
    }
    writeResponse(inDb, requestId, { ok: true, data: { applications: rows } });
  } catch (err) {
    log.error('handleListApplications failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// Exported for unit testing.
export const _testing = { encodeSuffix, slugify, deriveIndustry };
