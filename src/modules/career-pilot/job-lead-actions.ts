/**
 * Job-lead delivery action handlers (host side, Phase 2.5).
 *
 * Five handlers wired into the delivery sweep for the scrape-jobs flow:
 *   - career_pilot.record_job_lead       — host computes fingerprint +
 *                                          rules_score, UPSERTs into job_leads
 *   - career_pilot.query_job_leads       — typed-args SELECT
 *   - career_pilot.update_job_lead_status — funnel-state UPDATE
 *   - career_pilot.discover_ats_board    — regex-detect ATS provider+token
 *                                          from a careers page URL
 *   - career_pilot.fetch_source          — aggregate ATS list across
 *                                          seed-targets, returns normalized
 *                                          JobLeadPayload[]
 *
 * Pattern matches the Phase 1 actions in `actions.ts` (response writer,
 * payload extraction, error frames). Kept separate from actions.ts so the
 * Phase 1 + Phase 2.5 split stays readable.
 *
 * Spec: STRATEGY.md §6.2 + §24.5.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import { getAdapter } from '../../scrape-jobs/sources.js';
import { filterTargets } from '../../scrape-jobs/targets.js';
import type { JobLeadPayload, Source, SourcePriority, TargetEntry } from '../../scrape-jobs/types.js';
import type { Session } from '../../types.js';

import { computeFingerprint } from './lead-fingerprint.js';
import { computeRulesScore, profileFromRow } from './lead-rules-score.js';

// ── Response writer (mirrors actions.ts) ──────────────────────────────────

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
    trigger: 0,
  });
}

function reqId(content: Record<string, unknown>): string {
  return (content.requestId as string) || 'unknown';
}

function payload(content: Record<string, unknown>): Record<string, unknown> {
  return (content.payload as Record<string, unknown>) ?? {};
}

function generateLeadId(): string {
  return `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── record_job_lead ────────────────────────────────────────────────────────

const VALID_SOURCES = new Set<Source>(['greenhouse', 'lever']);
const VALID_STATUSES = new Set(['new', 'reviewed', 'queued', 'applied', 'rejected', 'archived']);

export async function handleRecordJobLead(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content) as Partial<JobLeadPayload>;

  if (!p.source || !VALID_SOURCES.has(p.source)) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: `source must be one of: ${[...VALID_SOURCES].join(', ')}` } });
    return;
  }
  if (!p.source_job_id || !p.source_url || !p.title || !p.company) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'source_job_id, source_url, title, and company are all required' },
    });
    return;
  }

  try {
    const db = getDb();

    // Load candidate profile for rules-score.
    const profileRow = db.prepare('SELECT * FROM candidate_profile WHERE id = 1').get() as Record<string, unknown> | null;
    const profile = profileFromRow(profileRow);

    // Compute fingerprint + rules_score.
    const fullPayload = p as JobLeadPayload;
    const fingerprint = computeFingerprint(fullPayload);
    const { score, reasons } = computeRulesScore(fullPayload, profile);

    const now = new Date().toISOString();
    const newId = generateLeadId();

    // UPSERT on (source, source_job_id). On conflict, advance last_seen_at + refresh
    // mutable content fields, but do NOT overwrite id, first_seen_at, status, or
    // application_id — those are downstream-owned.
    const stmt = db.prepare(`
      INSERT INTO job_leads (
        id, source, source_board_token, source_job_id, source_url, apply_url,
        content_fingerprint, title, company, company_domain, location_raw,
        is_remote, workplace_type, remote_region, employment_type,
        comp_min_usd, comp_max_usd, comp_currency, comp_period, has_equity,
        description_html, description_text,
        source_posted_at, first_seen_at, last_seen_at,
        rules_score, rules_score_reasons,
        status, status_changed_at, raw_payload
      ) VALUES (
        @id, @source, @source_board_token, @source_job_id, @source_url, @apply_url,
        @content_fingerprint, @title, @company, @company_domain, @location_raw,
        @is_remote, @workplace_type, @remote_region, @employment_type,
        @comp_min_usd, @comp_max_usd, @comp_currency, @comp_period, @has_equity,
        @description_html, @description_text,
        @source_posted_at, @now, @now,
        @rules_score, @rules_score_reasons,
        'new', @now, @raw_payload
      )
      ON CONFLICT (source, source_job_id) DO UPDATE SET
        last_seen_at        = excluded.last_seen_at,
        title               = excluded.title,
        apply_url           = excluded.apply_url,
        location_raw        = excluded.location_raw,
        is_remote           = excluded.is_remote,
        workplace_type      = excluded.workplace_type,
        remote_region       = excluded.remote_region,
        comp_min_usd        = excluded.comp_min_usd,
        comp_max_usd        = excluded.comp_max_usd,
        description_html    = excluded.description_html,
        description_text    = excluded.description_text,
        content_fingerprint = excluded.content_fingerprint,
        rules_score         = excluded.rules_score,
        rules_score_reasons = excluded.rules_score_reasons,
        raw_payload         = excluded.raw_payload
    `);

    const result = stmt.run({
      id: newId,
      source: p.source,
      source_board_token: p.source_board_token ?? null,
      source_job_id: p.source_job_id,
      source_url: p.source_url,
      apply_url: p.apply_url ?? null,
      content_fingerprint: fingerprint,
      title: p.title,
      company: p.company,
      company_domain: p.company_domain ?? null,
      location_raw: p.location_raw ?? null,
      is_remote: p.is_remote == null ? null : p.is_remote ? 1 : 0,
      workplace_type: p.workplace_type ?? null,
      remote_region: p.remote_region ?? null,
      employment_type: p.employment_type ?? null,
      comp_min_usd: p.comp_min_usd ?? null,
      comp_max_usd: p.comp_max_usd ?? null,
      comp_currency: p.comp_currency ?? 'USD',
      comp_period: p.comp_period ?? null,
      has_equity: p.has_equity == null ? null : p.has_equity ? 1 : 0,
      description_html: p.description_html ?? null,
      description_text: p.description_text ?? null,
      source_posted_at: p.source_posted_at ?? null,
      now,
      rules_score: score,
      rules_score_reasons: JSON.stringify(reasons),
      raw_payload: p.raw_payload ? JSON.stringify(p.raw_payload) : null,
    });

    // Look up the actual id (may be the existing one if upsert hit conflict).
    const row = db
      .prepare('SELECT id FROM job_leads WHERE source = ? AND source_job_id = ?')
      .get(p.source, p.source_job_id) as { id: string } | undefined;
    const finalId = row?.id ?? newId;
    const insertedOrUpdated = result.changes === 1 && finalId === newId ? 'inserted' : 'updated';

    log.info('job_lead recorded', { id: finalId, source: p.source, source_job_id: p.source_job_id, rules_score: score, action: insertedOrUpdated });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { id: finalId, inserted_or_updated: insertedOrUpdated, rules_score: score, content_fingerprint: fingerprint },
    });
  } catch (err) {
    log.error('handleRecordJobLead failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── query_job_leads ────────────────────────────────────────────────────────

const VALID_ORDER_BY = new Set(['rules_score', 'first_seen_at', 'last_seen_at']);

export async function handleQueryJobLeads(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);

  const status = p.status as string | undefined;
  const source = p.source as string | undefined;
  const min_rules_score = p.min_rules_score as number | undefined;
  const since = p.since as string | undefined;
  const company = p.company as string | undefined;
  const not_yet_llm_scored = p.not_yet_llm_scored as boolean | undefined;
  const limitRaw = p.limit as number | undefined;
  const limit = limitRaw && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : 20;
  const orderByRaw = p.order_by as string | undefined;
  const orderBy = orderByRaw && VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : 'rules_score';

  if (status && !VALID_STATUSES.has(status)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `status must be one of: ${[...VALID_STATUSES].join(', ')}` },
    });
    return;
  }
  if (source && !VALID_SOURCES.has(source as Source)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `source must be one of: ${[...VALID_SOURCES].join(', ')}` },
    });
    return;
  }

  try {
    const db = getDb();
    const where: string[] = ['closed_at IS NULL'];
    const params: Record<string, unknown> = {};
    if (status) {
      where.push('status = @status');
      params.status = status;
    }
    if (source) {
      where.push('source = @source');
      params.source = source;
    }
    if (typeof min_rules_score === 'number') {
      where.push('rules_score >= @min_rules_score');
      params.min_rules_score = min_rules_score;
    }
    if (since) {
      where.push('first_seen_at >= @since');
      params.since = since;
    }
    if (company) {
      where.push('LOWER(company) = LOWER(@company)');
      params.company = company;
    }
    if (not_yet_llm_scored) {
      where.push('llm_score IS NULL');
    }

    const orderClause = orderBy === 'rules_score'
      ? 'rules_score DESC, first_seen_at DESC'
      : `${orderBy} DESC`;

    const sql = `SELECT * FROM job_leads WHERE ${where.join(' AND ')} ORDER BY ${orderClause} LIMIT @limit`;
    params.limit = limit;

    const leads = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM job_leads WHERE ${where.join(' AND ')}`)
      .get(params) as { n: number };

    // Parse JSON columns for the caller's convenience.
    for (const lead of leads) {
      if (typeof lead.rules_score_reasons === 'string') {
        try {
          lead.rules_score_reasons = JSON.parse(lead.rules_score_reasons);
        } catch {
          /* leave as string */
        }
      }
    }

    writeResponse(inDb, requestId, { ok: true, data: { leads, total: totalRow.n } });
  } catch (err) {
    log.error('handleQueryJobLeads failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── update_job_lead_status ─────────────────────────────────────────────────

export async function handleUpdateJobLeadStatus(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const id = p.id as string;
  const status = p.status as string;
  const reason = (p.reason as string | undefined) ?? null;

  if (!id) {
    writeResponse(inDb, requestId, { ok: false, error: { code: 'BAD_ARGS', message: 'id is required' } });
    return;
  }
  if (!status || !VALID_STATUSES.has(status)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `status must be one of: ${[...VALID_STATUSES].join(', ')}` },
    });
    return;
  }

  try {
    const db = getDb();
    const existing = db.prepare('SELECT status FROM job_leads WHERE id = ?').get(id) as { status: string } | undefined;
    if (!existing) {
      writeResponse(inDb, requestId, { ok: false, error: { code: 'NOT_FOUND', message: `no job_lead with id "${id}"` } });
      return;
    }

    const now = new Date().toISOString();
    // 'archived' is implemented as soft-delete: set status='archived' AND closed_at.
    if (status === 'archived') {
      db.prepare(
        `UPDATE job_leads SET status = 'archived', status_changed_at = @now, closed_at = @now, closed_reason = @reason WHERE id = @id`,
      ).run({ id, now, reason: reason ?? 'manual' });
    } else {
      db.prepare(
        `UPDATE job_leads SET status = @status, status_changed_at = @now WHERE id = @id`,
      ).run({ id, status, now });
    }

    log.info('job_lead status updated', { id, from: existing.status, to: status });
    writeResponse(inDb, requestId, { ok: true, data: { id, from: existing.status, to: status } });
  } catch (err) {
    log.error('handleUpdateJobLeadStatus failed', { err: err instanceof Error ? err.message : String(err) });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── discover_ats_board ─────────────────────────────────────────────────────

const GREENHOUSE_URL_RE = /https?:\/\/(?:boards\.greenhouse\.io|boards-api\.greenhouse\.io)\/(?:embed\/job_board\?for=)?([\w-]+)/i;
const LEVER_URL_RE = /https?:\/\/jobs\.lever\.co\/([\w-]+)/i;

export async function handleDiscoverAtsBoard(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const careers_url = p.careers_url as string;

  if (!careers_url || !/^https?:\/\//i.test(careers_url)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'careers_url must be a valid http(s) URL' },
    });
    return;
  }

  try {
    const res = await fetch(careers_url, {
      headers: { 'User-Agent': 'career-pilot/0.1 ats-discovery' },
      redirect: 'follow',
    });
    if (!res.ok) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: { ats: null, token: null, confidence: 'none', http_status: res.status },
      });
      return;
    }
    const html = await res.text();

    const ghMatch = GREENHOUSE_URL_RE.exec(html);
    if (ghMatch) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: { ats: 'greenhouse', token: ghMatch[1], confidence: 'high' },
      });
      return;
    }
    const leverMatch = LEVER_URL_RE.exec(html);
    if (leverMatch) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: { ats: 'lever', token: leverMatch[1], confidence: 'high' },
      });
      return;
    }
    writeResponse(inDb, requestId, {
      ok: true,
      data: { ats: null, token: null, confidence: 'none' },
    });
  } catch (err) {
    log.warn('discover_ats_board fetch failed', { careers_url, err: err instanceof Error ? err.message : String(err) });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { ats: null, token: null, confidence: 'none', error: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── fetch_source ──────────────────────────────────────────────────────────

export async function handleFetchSource(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const priority = p.priority as SourcePriority | undefined;
  const company = p.company as string | undefined;
  const since = p.since as string | undefined; // unused in v1.0; filter applied client-side
  const limitRaw = p.limit as number | undefined;
  // v1.0 default raised from 20 → 60 after run 11: with the per-board
  // distribution (perBoardCap = ceil(limit / target_count), floor 3), 20
  // total = ~3 per board. Greenhouse returns postings ordered by
  // updated_at DESC, so the freshest 3 per board bias heavily toward
  // whatever the company is currently hiring fast for (sales/GTM, often).
  // 60 postings × ~1KB per posting (description text capped at 800) =
  // ~60KB — well inside the inline-result cap. With ~12 priority-A boards,
  // 60/12 = 5 per board, enough to surface engineering roles alongside the
  // sales/marketing freshest-batch.
  const limit = limitRaw && limitRaw > 0 && limitRaw <= 150 ? Math.floor(limitRaw) : 60;

  if (!priority && !company) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'one of `priority` or `company` is required' },
    });
    return;
  }
  if (priority && priority !== 'A' && priority !== 'B' && priority !== 'C') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'priority must be A, B, or C' },
    });
    return;
  }

  try {
    const targets = filterTargets({ priority, company });
    if (targets.length === 0) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: { postings: [], boards_scanned: 0, postings_total: 0, note: company ? `no seed entry for company "${company}"` : `no seed entries with priority ${priority}` },
      });
      return;
    }

    const allPostings: JobLeadPayload[] = [];
    const sinceTs = since ? new Date(since).getTime() : null;
    // Distribute the total limit across boards so the result spans
    // multiple companies. Without this, the first board (e.g.,
    // Anthropic's 100+ postings) consumes the full budget and the
    // subagent never sees Stripe/Vercel/etc. Per-board cap is
    // ceil(limit / target_count), with a floor of 3 to keep small
    // scans (single-company) workable.
    const perBoardCap = Math.max(3, Math.ceil(limit / Math.max(1, targets.length)));
    for (const target of targets) {
      const adapter = getAdapter(target.source);
      const postings = await adapter.list(target.token);
      let recordedFromThisBoard = 0;
      for (const posting of postings) {
        // Fill in the company name from the seed entry (adapters don't have it).
        posting.company = target.company;
        // Optional since-filter.
        if (sinceTs && posting.source_posted_at) {
          const postedTs = new Date(posting.source_posted_at).getTime();
          if (!Number.isNaN(postedTs) && postedTs < sinceTs) continue;
        }
        // Drop raw_payload from the subagent return path — it's only
        // useful for re-parsing in the DB layer, and including it adds
        // payload bytes the subagent doesn't need. The subagent will
        // pass back a payload via record_job_lead without raw_payload;
        // we accept that loss for v1.0 (re-fetch + repopulate is cheap).
        delete posting.raw_payload;
        allPostings.push(posting);
        recordedFromThisBoard += 1;
        if (recordedFromThisBoard >= perBoardCap) break;
        if (allPostings.length >= limit) break;
      }
      if (allPostings.length >= limit) break;
    }

    writeResponse(inDb, requestId, {
      ok: true,
      data: { postings: allPostings, boards_scanned: targets.length, postings_total: allPostings.length },
    });
  } catch (err) {
    log.error('handleFetchSource failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'FETCH_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}
