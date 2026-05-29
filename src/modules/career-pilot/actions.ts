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

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import { mirrorFunnelEvent } from '../portal/public-audit.js';
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
  'gmail_account',
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

// ── record_progress ────────────────────────────────────────────────────────

const PROGRESS_DETAIL_CAP = 200;
const PROGRESS_PER_SESSION_CAP = 6;

/**
 * Minimal PII sanitization for `record_progress` detail strings — the
 * Phase 2.3 stand-in for `src/modules/portal/sanitizer.ts`'s full
 * three-pass pipeline (Phase 3). Emails + phone-shaped digits get
 * redacted. Detail strings are short by construction (cap 200 chars) so
 * the inline regex pass is sufficient for the writer; the LLM
 * context-sensitivity pass is the Phase 3 add-on.
 */
function sanitizeProgressDetail(raw: string): string {
  return raw
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(?:\+?\d[\s.()-]?){9,}/g, '[phone]');
}

export async function handleRecordProgress(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const subagent_name = p.subagent_name as string;
  const stage = p.stage as string;
  const detail = p.detail as string;

  if (!subagent_name || !stage || typeof detail !== 'string' || !detail) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'subagent_name, stage, and detail are required (detail must be a non-empty string)' },
    });
    return;
  }

  const detailCapped = detail.length > PROGRESS_DETAIL_CAP ? `${detail.slice(0, PROGRESS_DETAIL_CAP - 3)}...` : detail;
  const summary = sanitizeProgressDetail(detailCapped);

  try {
    const db = getDb();

    // Per-(session, subagent) soft rate-limit. Approximates "per-run" — a
    // single Task call doesn't have a stable run_id exposed to MCP handlers,
    // and sessions are short-lived (~5 min ceiling), so per-session counting
    // is a workable proxy. Spec calls for 7th-call rejection (cap=6 prior).
    const sessionLike = `%"session_id":"${session.id}"%`;
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM public_audit_trail
            WHERE category = 'subagent_progress'
              AND agent_name = @agent
              AND details_json LIKE @sessionLike`,
        )
        .get({ agent: subagent_name, sessionLike }) as { n: number }
    ).n;
    if (count >= PROGRESS_PER_SESSION_CAP) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `record_progress cap reached (${count} prior calls for ${subagent_name} in this session)`,
        },
      });
      return;
    }

    const id = generateId('prog');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO public_audit_trail (id, ts, category, agent_name, summary, details_json)
       VALUES (@id, @ts, @category, @agent_name, @summary, @details_json)`,
    ).run({
      id,
      ts: now,
      category: 'subagent_progress',
      agent_name: subagent_name,
      summary,
      details_json: JSON.stringify({ stage, session_id: session.id }),
    });

    writeResponse(inDb, requestId, { ok: true, data: { id, stage } });
  } catch (err) {
    log.error('handleRecordProgress failed', { subagent_name, err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── create_gmail_draft ─────────────────────────────────────────────────────

const STUB_DRAFT_PREFIX = 'stub-draft-';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_HARD_CAP = 8_000;

/**
 * Materialize a Gmail draft on the candidate's behalf. Reversible (no send) —
 * the candidate must explicitly send from Gmail. No approval gate; the future
 * `send_outreach_email` tool is the one that lands approval-gating per
 * PORTAL.md §6.3.
 *
 * Stub mode: when `process.env.GMAIL_STUB === '1'`, returns a synthetic
 * `draft_id` matching `/^stub-draft-/` without touching the Gmail API. The
 * e2e flow runs in stub mode; real Gmail integration is verified manually
 * post-DoD.
 *
 * Sandbox isolation (Phase 2.3 simplification): host-side group-folder check
 * refuses for any folder other than `career-pilot`. The spec's preferred
 * mechanism is `disallowedTools` removal from the SDK context (per AGENT_SDK_
 * PATTERNS.md §6) — wiring that requires a `disallowedTools` field through
 * the container-config → container.json → provider-options stack. Filed as
 * follow-up (see task tracker); for Phase 2.3 the host-side refusal
 * satisfies DoD #8 (sandbox returns a clear error rather than materializing
 * a draft).
 */
export async function handleCreateGmailDraft(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const to = p.to as string;
  const subject = p.subject as string;
  const body = p.body as string;
  const in_reply_to = (p.in_reply_to as string | null | undefined) ?? null;

  // Sandbox isolation: only the owner agent group can materialize Gmail drafts.
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'create_gmail_draft is not available in this agent group (sandbox sessions cannot materialize real Gmail drafts).',
      },
    });
    return;
  }

  if (!to || !EMAIL_RE.test(to)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'to must be a valid email address' },
    });
    return;
  }
  if (!subject || typeof subject !== 'string') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'subject is required (non-empty string)' },
    });
    return;
  }
  if (!body || typeof body !== 'string') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'body is required (non-empty string)' },
    });
    return;
  }
  if (body.length > BODY_HARD_CAP) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'BAD_ARGS',
        message: `body exceeds hard cap (${body.length} > ${BODY_HARD_CAP} chars). The prompt-level cap is ≤200 words — something went wrong upstream.`,
      },
    });
    return;
  }

  const stubMode = process.env.GMAIL_STUB === '1';
  if (stubMode) {
    const draft_id = `${STUB_DRAFT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const draft_url = `https://mail.google.com/mail/u/0/#drafts/${draft_id}`;
    log.info('create_gmail_draft (stub)', { to, subject, body_chars: body.length, draft_id });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { draft_id, draft_url, stub: true, in_reply_to },
    });
    return;
  }

  // Real Gmail integration — TODO Phase 3+ (full OAuth onboarding wizard).
  // For Phase 2.3, real-mode lands behind a stub call against the Gmail API
  // via OneCLI-vaulted OAuth refresh token (host-pattern www.googleapis.com).
  // Until manual OneCLI registration is done, this branch returns a clear
  // error rather than half-implementing.
  writeResponse(inDb, requestId, {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Real Gmail draft creation is not yet wired (Phase 3+). Run with GMAIL_STUB=1 for now.',
    },
  });
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

    // Phase 4 §24.10 public mirror. Runs after writeResponse so mirror
    // latency never blocks the agent's MCP call. Errors are logged and
    // swallowed — the private write is committed regardless.
    try {
      mirrorFunnelEvent(db, event_id);
    } catch (mirrorErr) {
      log.error('mirrorFunnelEvent threw despite internal try/catch', { event_id, mirrorErr });
    }
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
