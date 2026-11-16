/**
 * Job-lead delivery action handlers (host side, Phase 2.5).
 *
 * Five handlers wired into the delivery sweep for the scrape-jobs flow:
 *   - career_pilot.record_job_lead       — host computes fingerprint +
 *                                          rules_score, UPSERTs into job_leads
 *   - career_pilot.query_job_leads       — typed-args SELECT
 *   - career_pilot.update_job_lead_status — pipeline-state UPDATE
 *   - career_pilot.discover_ats_board    — parse ATS provider+token from a
 *                                          board link (never fetched) and add a
 *                                          verified board to ats_watchlist
 *   - career_pilot.fetch_source          — aggregate ATS list across
 *                                          active ats_watchlist boards, returns lightweight
 *                                          PostingSummary[] (subagent's
 *                                          inline-cap budget) and stashes
 *                                          full JobLeadPayloads in the
 *                                          payload-cache for record_job_lead
 *                                          to look up later
 *
 * Pattern matches the Phase 1 actions in `actions.ts` (response writer,
 * payload extraction, error frames). Kept separate from actions.ts so the
 * Phase 1 + Phase 2.5 split stays readable.
 *
 * Spec: STRATEGY.md §6.2 + §24.5.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import * as payloadCache from './scrape-jobs/payload-cache.js';
import { getAdapter, toUtcIso } from './scrape-jobs/sources.js';
import { filterTargets } from './scrape-jobs/targets.js';
import {
  ATS_SOURCES,
  type AtsSource,
  type JobLeadPayload,
  type PostingSummary,
  type Source,
  type SourcePriority,
} from './scrape-jobs/types.js';
import type { Session } from '../../types.js';

import {
  ensureSeededOnce,
  findBoard,
  EU_BOARD_UNSUPPORTED_MESSAGE,
  growWatchlistFromSearchHits,
  isBoardRemoved,
  isValidBoardToken,
  parseAtsUrl,
  readWatchlistCaps,
  upsertBoard,
  type AtsUrlRef,
} from './ats-watchlist.js';
import { computeFingerprint } from './lead-fingerprint.js';
import { checkLeadGuard, resolveApplyLinkKind, type LeadGuardOptions, type LeadRefusalReason } from './lead-guard.js';
import { runKitCleanupSweep } from './interview-kit-actions.js';
import { computeRulesScore, profileFromRow } from './lead-rules-score.js';
import { recordSearchRun, searchPayloadSite } from './search-quota.js';
import { isWithinQuietHours, readProactiveGateConfig, startOfLocalDayUtcIso } from './quiet-hours.js';

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

const SNIPPET_CHARS = 120;

function toSummary(p: JobLeadPayload): PostingSummary {
  const desc = p.description_text ?? '';
  const cleaned = desc.replace(/\s+/g, ' ').trim();
  const snippet = cleaned.length > SNIPPET_CHARS ? cleaned.slice(0, SNIPPET_CHARS - 1) + '…' : cleaned;
  return {
    source: p.source,
    source_job_id: p.source_job_id,
    title: p.title,
    company: p.company,
    location_raw: p.location_raw ?? null,
    workplace_type: p.workplace_type ?? null,
    // §24.201 D1: the subagent sees how direct the link is (resolved exactly as
    // the writer stores it).
    apply_link_kind: resolveApplyLinkKind(p),
    snippet,
  };
}

// ── record_job_lead ────────────────────────────────────────────────────────

const VALID_SOURCES = new Set<Source>([...ATS_SOURCES, 'google_jobs']);
/** The job_leads lifecycle vocabulary — exported as the ONE source of truth so the
 * owner-only /admin Leads tab (§24.173) shares the exact allow-list the agent's
 * `update_job_lead_status` enforces, rather than re-declaring it. */
export const VALID_STATUSES = new Set(['new', 'reviewed', 'queued', 'applied', 'rejected', 'archived']);

export async function handleRecordJobLead(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);

  const source = p.source as Source | undefined;
  const source_job_id = p.source_job_id as string | undefined;

  if (!source || !VALID_SOURCES.has(source)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `source must be one of: ${[...VALID_SOURCES].join(', ')}` },
    });
    return;
  }
  if (!source_job_id) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'source_job_id is required' },
    });
    return;
  }

  // Look up the full payload from the fetch_source cache. If missing, the
  // subagent recorded a posting that we never returned to it (fabrication)
  // or the cache expired (rare — 1h TTL is much longer than a scrape run).
  const fullPayload = payloadCache.get(source, source_job_id);
  if (!fullPayload) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'NOT_IN_CACHE',
        message: `no cached payload for ${source}::${source_job_id} — call fetch_source first, do not invent source_job_ids`,
      },
    });
    return;
  }

  try {
    const result = upsertJobLead(getDb(), fullPayload);
    if (!result.recorded) {
      // A non-error refusal: a tombstone or blocklist entry written inside the
      // cache TTL (the stash already drops link-kind refusals). The subagent
      // must not retry, so this is ok:true with recorded:false.
      writeResponse(inDb, requestId, {
        ok: true,
        data: { recorded: false, reason: result.reason, detail: result.detail },
      });
      return;
    }
    writeResponse(inDb, requestId, {
      ok: true,
      data: {
        recorded: true,
        id: result.id,
        inserted_or_updated: result.inserted_or_updated,
        rules_score: result.rules_score,
        content_fingerprint: result.content_fingerprint,
      },
    });
  } catch (err) {
    log.error('handleRecordJobLead failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

export type UpsertJobLeadResult =
  | {
      recorded: true;
      id: string;
      inserted_or_updated: 'inserted' | 'updated';
      rules_score: number;
      content_fingerprint: string;
    }
  | { recorded: false; reason: LeadRefusalReason; detail: string };

/**
 * A guard-refused RE-SIGHTING of a lead still open in the pool (e.g. a stored
 * direct-link hit the index now ranks behind an aggregator link) is still
 * evidence the posting is live: advance its last_seen_at so the stale rule does
 * not close it — but never let the refused content overwrite the row. Returns
 * true when an open row was refreshed. Shared by the stash (which refuses early,
 * so a refused re-sighting never reaches record) and the writer.
 */
export function refreshLastSeenOfOpenLead(db: Database.Database, source: string, sourceJobId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE job_leads SET last_seen_at = ?
          WHERE source = ? AND source_job_id = ? AND closed_at IS NULL`,
      )
      .run(new Date().toISOString(), source, sourceJobId).changes > 0
  );
}

/**
 * The one job_leads writer (§24.201 D1). Runs the shared pre-insert guard, then
 * UPSERTs on (source, source_job_id): on conflict it advances last_seen_at and
 * refreshes the mutable content fields, but never overwrites id, first_seen_at,
 * status or application_id — those are downstream-owned. Every path that adds a
 * lead goes through here so the guard cannot be skipped. Throws only on a DB
 * error; callers map that to their own error frame. `guardOpts.ownerChosen` is
 * passed ONLY by the owner's add-by-URL (§24.202 D7) — see `LeadGuardOptions`.
 */
export function upsertJobLead(
  db: Database.Database,
  fp: JobLeadPayload,
  guardOpts: LeadGuardOptions = {},
): UpsertJobLeadResult {
  // Fingerprint first: the guard's tombstone compare and the row share it.
  const fingerprint = computeFingerprint(fp);
  const guard = checkLeadGuard(db, fp, fingerprint, guardOpts);
  if (!guard.ok) {
    const refreshed = refreshLastSeenOfOpenLead(db, fp.source, fp.source_job_id);
    log.info('job_lead refused by insert guard', {
      source: fp.source,
      source_job_id: fp.source_job_id,
      reason: guard.reason,
      detail: guard.detail,
      tombstone_id: guard.tombstone_id,
      last_seen_refreshed: refreshed,
    });
    return { recorded: false, reason: guard.reason, detail: guard.detail };
  }

  // Load candidate profile for rules-score.
  const profileRow = db.prepare('SELECT * FROM candidate_profile WHERE id = 1').get() as Record<string, unknown> | null;
  const profile = profileFromRow(profileRow);
  const { score, reasons } = computeRulesScore(fp, profile);

  const now = new Date().toISOString();
  const newId = generateLeadId();

  const stmt = db.prepare(`
    INSERT INTO job_leads (
      id, source, source_board_token, source_job_id, source_url, apply_url, apply_link_kind,
      content_fingerprint, title, company, company_domain, location_raw,
      is_remote, workplace_type, remote_region, employment_type,
      comp_min_usd, comp_max_usd, comp_currency, comp_period, has_equity,
      description_html, description_text,
      source_posted_at, first_seen_at, last_seen_at,
      rules_score, rules_score_reasons,
      status, status_changed_at, raw_payload
    ) VALUES (
      @id, @source, @source_board_token, @source_job_id, @source_url, @apply_url, @apply_link_kind,
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
      apply_link_kind     = excluded.apply_link_kind,
      source_url          = excluded.source_url,
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
    source: fp.source,
    source_board_token: fp.source_board_token ?? null,
    source_job_id: fp.source_job_id,
    source_url: fp.source_url,
    apply_url: fp.apply_url ?? null,
    // §24.190. greenhouse/lever adapters hit the employer's own ATS board by
    // construction, so they're 'ats' without needing to say so; only the
    // aggregator-fed google_jobs path has to classify per-lead. The guard
    // resolves a missing kind with this same function (§24.201 D1).
    apply_link_kind: resolveApplyLinkKind(fp),
    content_fingerprint: fingerprint,
    title: fp.title,
    company: fp.company,
    company_domain: fp.company_domain ?? null,
    location_raw: fp.location_raw ?? null,
    is_remote: fp.is_remote == null ? null : fp.is_remote ? 1 : 0,
    workplace_type: fp.workplace_type ?? null,
    remote_region: fp.remote_region ?? null,
    employment_type: fp.employment_type ?? null,
    comp_min_usd: fp.comp_min_usd ?? null,
    comp_max_usd: fp.comp_max_usd ?? null,
    comp_currency: fp.comp_currency ?? 'USD',
    comp_period: fp.comp_period ?? null,
    has_equity: fp.has_equity == null ? null : fp.has_equity ? 1 : 0,
    description_html: fp.description_html ?? null,
    description_text: fp.description_text ?? null,
    // Canonical UTC for every writer: killer-match compares this column as text
    // against a `…Z` cutoff, so a stored offset would skew its window.
    source_posted_at: toUtcIso(fp.source_posted_at),
    now,
    rules_score: score,
    rules_score_reasons: JSON.stringify(reasons),
    raw_payload: fp.raw_payload ? JSON.stringify(fp.raw_payload) : null,
  });

  // Look up the actual id (may be the existing one if upsert hit conflict).
  const row = db
    .prepare('SELECT id FROM job_leads WHERE source = ? AND source_job_id = ?')
    .get(fp.source, fp.source_job_id) as { id: string } | undefined;
  const finalId = row?.id ?? newId;
  const insertedOrUpdated = result.changes === 1 && finalId === newId ? 'inserted' : 'updated';

  log.info('job_lead recorded', {
    id: finalId,
    source: fp.source,
    source_job_id: fp.source_job_id,
    rules_score: score,
    action: insertedOrUpdated,
  });
  return {
    recorded: true,
    id: finalId,
    inserted_or_updated: insertedOrUpdated,
    rules_score: score,
    content_fingerprint: fingerprint,
  };
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

    const orderClause = orderBy === 'rules_score' ? 'rules_score DESC, first_seen_at DESC' : `${orderBy} DESC`;

    const sql = `SELECT * FROM job_leads WHERE ${where.join(' AND ')} ORDER BY ${orderClause} LIMIT @limit`;
    params.limit = limit;

    const leads = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM job_leads WHERE ${where.join(' AND ')}`).get(params) as {
      n: number;
    };

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
      writeResponse(inDb, requestId, {
        ok: false,
        error: { code: 'NOT_FOUND', message: `no job_lead with id "${id}"` },
      });
      return;
    }

    const now = new Date().toISOString();
    // 'archived' is implemented as soft-delete: set status='archived' AND closed_at.
    if (status === 'archived') {
      db.prepare(
        `UPDATE job_leads SET status = 'archived', status_changed_at = @now, closed_at = @now, closed_reason = @reason WHERE id = @id`,
      ).run({ id, now, reason: reason ?? 'manual' });
    } else {
      db.prepare(`UPDATE job_leads SET status = @status, status_changed_at = @now WHERE id = @id`).run({
        id,
        status,
        now,
      });
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

// ── get_lead_summaries_for_ranking ─────────────────────────────────────────
//
// Read-side half of the container-side rank_leads MCP tool. Container
// fetches summaries via this action, calls Haiku locally through the
// OneCLI-gated SDK path, then writes scores back via write_llm_scores.
// See container/agent-runner/src/career-pilot/rank-leads.ts.

interface LeadSummary {
  id: string;
  source: string;
  title: string;
  company: string;
  location_raw: string | null;
  workplace_type: string | null;
  description_text: string | null;
  rules_score: number | null;
}

const RANK_LEADS_MAX = 50;

export async function handleGetLeadSummariesForRanking(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const lead_ids = p.lead_ids;

  if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'lead_ids must be a non-empty array' },
    });
    return;
  }
  if (lead_ids.length > RANK_LEADS_MAX) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `lead_ids capped at ${RANK_LEADS_MAX} per call` },
    });
    return;
  }
  const idsAreStrings = lead_ids.every((x) => typeof x === 'string' && x.length > 0);
  if (!idsAreStrings) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'every lead_ids entry must be a non-empty string' },
    });
    return;
  }
  const ids = lead_ids as string[];

  try {
    const db = getDb();
    const placeholders = ids.map((_, i) => `@id_${i}`).join(', ');
    const params: Record<string, unknown> = {};
    ids.forEach((id, i) => {
      params[`id_${i}`] = id;
    });
    const rows = db
      .prepare(
        `SELECT id, source, title, company, location_raw, workplace_type, description_text, rules_score
         FROM job_leads
         WHERE id IN (${placeholders}) AND closed_at IS NULL`,
      )
      .all(params) as LeadSummary[];

    writeResponse(inDb, requestId, {
      ok: true,
      data: { leads: rows },
    });
  } catch (err) {
    log.error('handleGetLeadSummariesForRanking failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── write_llm_scores ───────────────────────────────────────────────────────

interface ScoredLead {
  id: string;
  llm_score: number;
}

export async function handleWriteLlmScores(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const scored_leads = p.scored_leads;
  const brief_hash = p.brief_hash;

  if (!Array.isArray(scored_leads) || scored_leads.length === 0) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'scored_leads must be a non-empty array' },
    });
    return;
  }
  if (typeof brief_hash !== 'string' || !/^[0-9a-f]{16}$/.test(brief_hash)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'brief_hash must be a 16-char hex string' },
    });
    return;
  }
  const valid = scored_leads.every((item: unknown): item is ScoredLead => {
    if (!item || typeof item !== 'object') return false;
    const s = item as Record<string, unknown>;
    return (
      typeof s.id === 'string' &&
      s.id.length > 0 &&
      typeof s.llm_score === 'number' &&
      Number.isFinite(s.llm_score) &&
      s.llm_score >= 0 &&
      s.llm_score <= 100
    );
  });
  if (!valid) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'each scored_leads entry must be { id: string, llm_score: 0-100 }' },
    });
    return;
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();
    const updateStmt = db.prepare(
      `UPDATE job_leads
       SET llm_score = @score,
           llm_scored_at = @now,
           llm_scored_brief_hash = @hash
       WHERE id = @id`,
    );
    let updated = 0;
    db.transaction(() => {
      for (const item of scored_leads as ScoredLead[]) {
        const res = updateStmt.run({
          id: item.id,
          score: Math.round(item.llm_score),
          now,
          hash: brief_hash,
        });
        updated += res.changes;
      }
    })();

    log.info('llm scores written', { count: scored_leads.length, updated, brief_hash });
    writeResponse(inDb, requestId, { ok: true, data: { updated } });
  } catch (err) {
    log.error('handleWriteLlmScores failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── claim_killer_matches ───────────────────────────────────────────────────
//
// SELECT-for-claim transaction backing the container-side `query_killer_matches`
// MCP tool. Atomicity guarantee: the SELECT and the UPDATE marking
// `killer_match_pushed_at` run inside a single `db.transaction(...)`, so a
// second concurrent caller sees zero matching rows.

interface KillerMatchLead {
  id: string;
  title: string;
  company: string;
  source: string;
  source_url: string;
  apply_url: string | null;
  rules_score: number;
  source_posted_at: string;
  first_seen_at: string;
  rules_score_reasons: unknown;
}

interface KillerMatchPreferences {
  minRulesScore: number;
  recencyWindowHours: number;
  sourceAllowList: string[];
  maxPerFire: number;
}

function readKillerMatchActionPrefs(db: Database.Database): KillerMatchPreferences {
  // Defaults (min_rules_score=90, recency_window_hours=6, source_allow_list=
  // ["greenhouse","lever"], max_per_fire=3) live in config/defaults.json;
  // getConfig resolves env > preferences table > defaults and coerces types.
  return {
    minRulesScore: getConfig<number>(db, 'killer_match_min_rules_score'),
    recencyWindowHours: getConfig<number>(db, 'killer_match_recency_window_hours'),
    sourceAllowList: getConfig<string[]>(db, 'killer_match_source_allow_list'),
    maxPerFire: getConfig<number>(db, 'killer_match_max_per_fire'),
  };
}

/**
 * The killer-match eligibility WHERE clause + its bound params — the single
 * source of truth shared by `claim_killer_matches` (which adds the projection,
 * ORDER/LIMIT, and the `killer_match_pushed_at` UPDATE) and the read-only
 * `check_trigger_eligibility` gate (§24.49c, which only COUNTs). Factoring this
 * out means the pre-wake gate can never drift from what the woken turn acts on.
 * `now` is injected so the cutoff and the caller's claim-stamp share one instant.
 *
 * §24.9 suppression: skip leads with any inbox activity already linked to them
 * (the candidate has engaged — re-alerting would be noisy). The pipeline-scribe
 * writes those linkages into email_events.
 */
export function buildKillerMatchEligibilityClause(
  prefs: KillerMatchPreferences,
  now: Date,
): { whereSql: string; params: Record<string, unknown> } {
  const cutoff = new Date(now.getTime() - prefs.recencyWindowHours * 60 * 60 * 1000).toISOString();
  const placeholders = prefs.sourceAllowList.map((_, i) => `@src_${i}`).join(', ');
  const params: Record<string, unknown> = { min_rules_score: prefs.minRulesScore, cutoff };
  prefs.sourceAllowList.forEach((src, i) => {
    params[`src_${i}`] = src;
  });
  // §24.201 D6e: never alert on a posting the owner already applied to (from the
  // Leads tab the link lands before any email does) or set aside.
  const whereSql = `killer_match_pushed_at IS NULL
        AND closed_at IS NULL
        AND application_id IS NULL
        AND status NOT IN ('applied', 'archived')
        AND rules_score >= @min_rules_score
        AND source IN (${placeholders})
        AND source_posted_at IS NOT NULL
        AND source_posted_at >= @cutoff
        AND id NOT IN (
          SELECT DISTINCT linked_job_lead_id FROM email_events
          WHERE linked_job_lead_id IS NOT NULL
        )`;
  return { whereSql, params };
}

export async function handleClaimKillerMatches(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);

  try {
    const db = getDb();
    const prefs = readKillerMatchActionPrefs(db);

    if (prefs.sourceAllowList.length === 0) {
      log.warn('claim_killer_matches: source_allow_list is empty; no alerts will fire');
      writeResponse(inDb, requestId, {
        ok: true,
        data: { leads: [], total: 0, reason: 'source_allow_list is empty' },
      });
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const { whereSql, params: whereParams } = buildKillerMatchEligibilityClause(prefs, now);
    const params: Record<string, unknown> = { ...whereParams, now: nowIso, limit: prefs.maxPerFire };

    const selectSql = `
      SELECT id, title, company, source, source_url, apply_url, rules_score,
             source_posted_at, first_seen_at, rules_score_reasons
      FROM job_leads
      WHERE ${whereSql}
      ORDER BY rules_score DESC, first_seen_at DESC
      LIMIT @limit
    `;

    const claimed: KillerMatchLead[] = [];
    db.transaction(() => {
      const rows = db.prepare(selectSql).all(params) as Array<KillerMatchLead & { rules_score_reasons: string | null }>;
      if (rows.length === 0) return;
      const ids = rows.map((r) => r.id);
      const updatePlaceholders = ids.map((_, i) => `@id_${i}`).join(', ');
      const updateParams: Record<string, unknown> = { now: nowIso };
      ids.forEach((id, i) => {
        updateParams[`id_${i}`] = id;
      });
      db.prepare(`UPDATE job_leads SET killer_match_pushed_at = @now WHERE id IN (${updatePlaceholders})`).run(
        updateParams,
      );
      for (const row of rows) {
        if (typeof row.rules_score_reasons === 'string') {
          try {
            row.rules_score_reasons = JSON.parse(row.rules_score_reasons);
          } catch {
            /* leave as string */
          }
        }
        claimed.push(row);
      }
    })();

    if (claimed.length > 0) {
      log.info('killer-match leads claimed', {
        count: claimed.length,
        ids: claimed.map((c) => c.id),
      });
    }

    writeResponse(inDb, requestId, {
      ok: true,
      data: { leads: claimed, total: claimed.length },
    });
  } catch (err) {
    log.error('handleClaimKillerMatches failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── close_stale_leads (§24.8) ─────────────────────────────────────────────
//
// Periodic sweep that closes leads whose source-posting hasn't been seen in
// a configurable threshold (default 14 days). `record_job_lead`'s UPSERT
// path advances `last_seen_at` on re-encounter, so a stale `last_seen_at`
// directly implies the posting is no longer being returned by scrape-jobs.
//
// Promoted leads (those with `application_id` set) are excluded — the
// application history is more important than the pool-cleanliness signal.

function readCloseDetectionThresholdDays(db: Database.Database): number {
  // Default (14) lives in config/defaults.json; getConfig resolves env > preferences > defaults.
  return getConfig<number>(db, 'close_detection_threshold_days');
}

/**
 * The close-detection eligibility WHERE clause + its bound params — the single
 * source of truth shared by `close_stale_leads` (the UPDATE) and the read-only
 * `check_trigger_eligibility` gate (§24.49c, which only COUNTs). `record_job_lead`'s
 * UPSERT advances `last_seen_at` on re-encounter, so a stale `last_seen_at`
 * directly implies the posting is no longer being scraped. Promoted leads
 * (`application_id` set) are excluded — the application history outweighs the
 * pool-cleanliness signal.
 *
 * §24.201 D6c: scoped to SEARCH-sourced leads. A board lead's presence is
 * refreshed by the sweep and its closure is decided by close-on-absence
 * (`closeAbsentLeads`) from a real fetch of its board; the age of `last_seen_at`
 * says nothing about it, so this rule must never close one — WHILE its board is
 * being swept. A board lead whose board is not an `active` watchlist row (paused
 * by "block company", retired as absent, or never watched) has no
 * close-on-absence path any more, so it falls back to this rule: its
 * last_seen_at stopped advancing when the sweeps stopped, and it ages out.
 */
export const STALE_RULE_SOURCES: readonly Source[] = ['google_jobs'];

export function buildCloseStaleEligibilityClause(
  thresholdDays: number,
  now: Date,
): { whereSql: string; params: Record<string, unknown> } {
  const cutoff = new Date(now.getTime() - thresholdDays * 86_400_000).toISOString();
  const params: Record<string, unknown> = { cutoff };
  const placeholders = STALE_RULE_SOURCES.map((src, i) => {
    params[`stale_src_${i}`] = src;
    return `@stale_src_${i}`;
  }).join(', ');
  const boardPlaceholders = ATS_SOURCES.map((src, i) => {
    params[`board_src_${i}`] = src;
    return `@board_src_${i}`;
  }).join(', ');
  const whereSql = `closed_at IS NULL
            AND application_id IS NULL
            AND (source IN (${placeholders})
                 OR (source IN (${boardPlaceholders})
                     AND NOT EXISTS (SELECT 1 FROM ats_watchlist w
                                      WHERE w.ats = job_leads.source
                                        AND w.token = job_leads.source_board_token
                                        AND w.state = 'active')))
            AND last_seen_at < @cutoff`;
  return { whereSql, params };
}

// ── board-lead lifecycle primitives (§24.201 D6c) ─────────────────────────
//
// The deterministic sweep calls these after each fetch of one watched board.
// They are pure DB operations (no fetch, no config), synchronous, and safe to
// run inside the caller's transaction. `presentIds` is ALWAYS the board's full
// id list from an `ok` fetch — before any title / location / age filter — since
// a filtered-out posting is still on the board.

const ID_CHUNK = 500;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += ID_CHUNK) out.push(xs.slice(i, i + ID_CHUNK));
  return out;
}

/**
 * Stamp `last_seen_at` on every known OPEN lead of `source` whose id is still on
 * the board. Returns how many leads were refreshed.
 */
export function markLeadsPresent(
  db: Database.Database,
  source: AtsSource,
  presentIds: readonly string[],
  now: Date = new Date(),
): number {
  let n = 0;
  const nowIso = now.toISOString();
  for (const part of chunks(presentIds)) {
    const ph = part.map(() => '?').join(', ');
    n += db
      .prepare(
        `UPDATE job_leads SET last_seen_at = ?
          WHERE source = ? AND closed_at IS NULL AND source_job_id IN (${ph})`,
      )
      .run(nowIso, source, ...part).changes;
  }
  return n;
}

export interface CloseAbsentResult {
  /** Ids of the leads closed with closed_reason='absent'. */
  closed: string[];
  /** Open `queued` leads whose posting came down: NOT closed — the owner meant
   *  to apply, so the run summary surfaces them instead. */
  queued: Array<{ id: string; title: string; company: string }>;
  /** True when an `ok` fetch returned zero postings for a board that had open
   *  leads — treated as a bad response, so nothing was closed. */
  suspect: boolean;
}

/**
 * Close-on-absence for ONE board after an `ok` fetch: an open lead of
 * (source, boardToken) whose id is not in `presentIds` is closed with
 * closed_reason='absent' — except a promoted lead (`application_id` set) or one
 * the owner applied to / queued (requisitions routinely come down right after
 * the candidate applies). Call it only for an `ok` fetch: a failed fetch or an
 * `absent` board must close nothing.
 */
export function closeAbsentLeads(
  db: Database.Database,
  source: AtsSource,
  boardToken: string,
  presentIds: readonly string[],
  now: Date = new Date(),
): CloseAbsentResult {
  const open = db
    .prepare(
      `SELECT id, source_job_id, title, company, status, application_id
         FROM job_leads
        WHERE source = ? AND source_board_token = ? AND closed_at IS NULL`,
    )
    .all(source, boardToken) as Array<{
    id: string;
    source_job_id: string;
    title: string;
    company: string;
    status: string;
    application_id: string | null;
  }>;
  if (open.length === 0) return { closed: [], queued: [], suspect: false };
  if (presentIds.length === 0) {
    log.warn('close-on-absence: ok fetch returned an empty board that had open leads — closing nothing', {
      source,
      boardToken,
      open: open.length,
    });
    return { closed: [], queued: [], suspect: true };
  }

  const present = new Set(presentIds);
  const gone = open.filter((l) => !present.has(l.source_job_id));
  const queued = gone
    .filter((l) => l.application_id == null && l.status === 'queued')
    .map((l) => ({ id: l.id, title: l.title, company: l.company }));
  const toClose = gone.filter((l) => l.application_id == null && l.status !== 'applied' && l.status !== 'queued');

  const nowIso = now.toISOString();
  const close = db.prepare(
    `UPDATE job_leads SET closed_at = ?, closed_reason = 'absent'
      WHERE id = ? AND closed_at IS NULL AND application_id IS NULL AND status NOT IN ('applied', 'queued')`,
  );
  const closed: string[] = [];
  for (const l of toClose) {
    if (close.run(nowIso, l.id).changes > 0) closed.push(l.id);
  }
  if (closed.length > 0) log.info('close-on-absence: leads closed', { source, boardToken, closed: closed.length });
  return { closed, queued, suspect: false };
}

/**
 * Reopen leads of `source` that were closed as `absent` and are back on the
 * board: clears closed_at / closed_reason and stamps last_seen_at. A lead closed
 * for any other reason (archived, not interested, stale) stays closed. Returns
 * the reopened ids.
 */
export function reopenAbsentLeads(
  db: Database.Database,
  source: AtsSource,
  presentIds: readonly string[],
  now: Date = new Date(),
): string[] {
  const reopened: string[] = [];
  const nowIso = now.toISOString();
  for (const part of chunks(presentIds)) {
    const ph = part.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id FROM job_leads
          WHERE source = ? AND closed_at IS NOT NULL AND closed_reason = 'absent' AND source_job_id IN (${ph})`,
      )
      .all(source, ...part) as Array<{ id: string }>;
    const reopen = db.prepare(
      `UPDATE job_leads SET closed_at = NULL, closed_reason = NULL, last_seen_at = ?
        WHERE id = ? AND closed_reason = 'absent'`,
    );
    for (const r of rows) if (reopen.run(nowIso, r.id).changes > 0) reopened.push(r.id);
  }
  if (reopened.length > 0) log.info('close-on-absence: leads reopened', { source, reopened: reopened.length });
  return reopened;
}

export interface BoardPresenceResult extends CloseAbsentResult {
  reopened: string[];
  refreshed: number;
}

/**
 * The three primitives in the order one `ok` board fetch needs them, in one
 * transaction: reopen what came back, stamp what is present, close what is gone.
 * (`refreshed` includes the reopened leads, which are open again by then.)
 */
export function applyBoardPresence(
  db: Database.Database,
  source: AtsSource,
  boardToken: string,
  presentIds: readonly string[],
  now: Date = new Date(),
): BoardPresenceResult {
  return db.transaction(() => {
    const reopened = presentIds.length > 0 ? reopenAbsentLeads(db, source, presentIds, now) : [];
    const refreshed = markLeadsPresent(db, source, presentIds, now);
    const closeRes = closeAbsentLeads(db, source, boardToken, presentIds, now);
    return { ...closeRes, reopened, refreshed };
  })();
}

export async function handleCloseStaleLeads(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  try {
    const db = getDb();
    const thresholdDays = readCloseDetectionThresholdDays(db);
    ensureSeededOnce(db); // the clause asks the watchlist which boards are swept
    const now = new Date();
    const nowIso = now.toISOString();
    const { whereSql, params } = buildCloseStaleEligibilityClause(thresholdDays, now);
    const cutoff = params.cutoff as string;

    const result = db
      .prepare(
        `UPDATE job_leads
            SET closed_at = @now, closed_reason = 'stale'
          WHERE ${whereSql}`,
      )
      .run({ now: nowIso, ...params });

    const closedCount = result.changes;
    if (closedCount > 0) {
      log.info('close-detection: leads closed', { closedCount, thresholdDays, cutoff });
    }

    writeResponse(inDb, requestId, {
      ok: true,
      data: { closed_count: closedCount, threshold_days: thresholdDays, cutoff },
    });

    // §24.53: ride the daily housekeeping sweep — archive interview kits whose
    // application is terminal or ghosted past the threshold (the backstop for
    // the symmetric terminal-transition archive). Best-effort AFTER writeResponse
    // (it touches Drive; must never block or fail the lead-close response).
    if (getConfig<boolean>(db, 'interview_kit_cleanup_enabled', true)) {
      void runKitCleanupSweep(db).catch((sweepErr) =>
        log.error('interview-kit cleanup sweep (rode close-detection) failed', { sweepErr }),
      );
    }
  } catch (err) {
    log.error('handleCloseStaleLeads failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── check_trigger_eligibility (§24.49c) ────────────────────────────────────
//
// Read-only pre-wake gate for the scheduled triggers. The container's
// pre-task script round-trips here BEFORE the agent turn; `eligible:false`
// lets the script return `{wakeAgent:false}` so a no-work fire makes ZERO
// model calls. Shares the EXACT WHERE clauses the woken turn would act on
// (buildKillerMatchEligibilityClause / buildCloseStaleEligibilityClause), so
// the gate can only ever skip a fire the turn would have no-op'd. NEVER
// mutates — the killer-match claim + the stale-lead close stay the turn's job.

type TriggerKind = 'killer-match' | 'close-detection';

export async function handleCheckTriggerEligibility(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const trigger = payload(content).trigger as TriggerKind | undefined;

  try {
    const db = getDb();

    if (trigger === 'killer-match') {
      const prefs = readKillerMatchActionPrefs(db);
      // Empty allow-list ⇒ claim would fire nothing (mirrors handleClaimKillerMatches).
      if (prefs.sourceAllowList.length === 0) {
        writeResponse(inDb, requestId, {
          ok: true,
          data: { trigger, eligible: false, count: 0, reason: 'source_allow_list is empty' },
        });
        return;
      }

      // Proactive guardrails (§24.52): suppress off-hours / over-cap fires BEFORE
      // the turn (zero model call). Host-enforced so they're a hard gate, not the
      // agent's best effort. killer-match is the only frequent proactive messager
      // and the only one that fires adjacent to the default quiet window.
      const now = new Date();
      const gate = readProactiveGateConfig(db);
      if (isWithinQuietHours(now, gate.quietHours, gate.quietHoursTz)) {
        writeResponse(inDb, requestId, {
          ok: true,
          data: { trigger, eligible: false, count: 0, reason: 'quiet_hours' },
        });
        return;
      }
      if (gate.capPerDay > 0) {
        const cutoff = startOfLocalDayUtcIso(now, gate.quietHoursTz);
        const pushedToday = (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM job_leads WHERE killer_match_pushed_at IS NOT NULL AND killer_match_pushed_at >= ?',
            )
            .get(cutoff) as { n: number }
        ).n;
        if (pushedToday >= gate.capPerDay) {
          writeResponse(inDb, requestId, {
            ok: true,
            data: { trigger, eligible: false, count: 0, reason: 'frequency_cap' },
          });
          return;
        }
      }

      const { whereSql, params } = buildKillerMatchEligibilityClause(prefs, now);
      const row = db.prepare(`SELECT COUNT(*) AS n FROM job_leads WHERE ${whereSql}`).get(params) as { n: number };
      writeResponse(inDb, requestId, { ok: true, data: { trigger, eligible: row.n > 0, count: row.n } });
      return;
    }

    if (trigger === 'close-detection') {
      const thresholdDays = readCloseDetectionThresholdDays(db);
      ensureSeededOnce(db);
      const { whereSql, params } = buildCloseStaleEligibilityClause(thresholdDays, new Date());
      const row = db.prepare(`SELECT COUNT(*) AS n FROM job_leads WHERE ${whereSql}`).get(params) as { n: number };
      writeResponse(inDb, requestId, { ok: true, data: { trigger, eligible: row.n > 0, count: row.n } });
      return;
    }

    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'trigger must be one of: killer-match, close-detection' },
    });
  } catch (err) {
    log.error('handleCheckTriggerEligibility failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── discover_ats_board ─────────────────────────────────────────────────────

// Board references as they appear in a careers page's HTML (links, embeds,
// iframes). Each captures the board token. Greenhouse: the current
// job-boards.* host, the legacy boards.* host (incl. the embed and embed-js
// `?for=` forms) and the API host. Ashby: the hosted board / embed host and the
// public posting API.
const ATS_REF_PATTERNS: ReadonlyArray<{ ats: AtsSource; re: RegExp }> = [
  {
    ats: 'greenhouse',
    re: /https?:\/\/(?:job-boards|boards)\.(?:eu\.)?greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w.-]+)/i,
  },
  { ats: 'greenhouse', re: /https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([\w.-]+)/i },
  { ats: 'greenhouse', re: /https?:\/\/(?:job-boards|boards)\.(?:eu\.)?greenhouse\.io\/(?!embed\b)([\w.-]+)/i },
  { ats: 'lever', re: /https?:\/\/jobs\.(?:eu\.)?lever\.co\/([\w.-]+)/i },
  { ats: 'ashby', re: /https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([\w.-]+)/i },
  { ats: 'ashby', re: /https?:\/\/jobs\.ashbyhq\.com\/([\w.-]+)/i },
];

/**
 * First ATS board reference in `text` with a well-formed token, or null. The
 * token is lower-cased — the watchlist's canonical form, as `parseAtsUrl` does —
 * and an EU-region host is marked `region:'eu'`. Exported for tests.
 */
export function detectAtsBoard(text: string): AtsUrlRef | null {
  for (const { ats, re } of ATS_REF_PATTERNS) {
    const m = re.exec(text);
    if (m && isValidBoardToken(m[1])) {
      const ref: AtsUrlRef = { ats, token: m[1].toLowerCase() };
      if (/^https?:\/\/[^/]*\.eu\./i.test(m[0])) ref.region = 'eu';
      return ref;
    }
  }
  return null;
}

/**
 * The board a `discover_ats_board` URL names: `parseAtsUrl` first (the one parser
 * every growth path shares), then the API / embed-script forms only
 * `detectAtsBoard` knows — and only when the URL's own host is an ATS host, so a
 * board link inside some other site's query string is not taken as one.
 */
function discoverRef(url: string): AtsUrlRef | null {
  const parsed = parseAtsUrl(url);
  if (parsed && isValidBoardToken(parsed.token)) {
    return parsed.region
      ? { ats: parsed.ats, token: parsed.token, region: parsed.region }
      : { ats: parsed.ats, token: parsed.token };
  }
  return /^https?:\/\/(?:[\w-]+\.)*(?:greenhouse\.io|lever\.co|ashbyhq\.com)\//i.test(url) ? detectAtsBoard(url) : null;
}

/**
 * Parse a Greenhouse / Lever / Ashby board link and — once the board's public
 * API answers — add it to the watchlist as origin 'owner' (§24.201 D7), so the
 * next sweep and every `fetch_source` reach it with no file edit.
 *
 * The host NEVER fetches the supplied URL (§24.201 D7, §24.202 D7): it parses
 * `{ats, token}` against fixed per-ATS host patterns and calls only the
 * adapter's own API host. A careers page that merely embeds a board is answered
 * `reason:'not_a_board_link'` — the agent reads the page itself (in its
 * container) and passes the board link it finds. An agent-supplied URL is
 * untrusted (job-page text can steer the model), and a host-side fetch of it
 * would be a probe of the VM's own network.
 *
 * An unverified board is reported but not added. Re-adding a RETIRED (`absent`)
 * board that answers again reactivates it; a PAUSED board stays paused — a pause
 * is the owner's "block company", and only the owner lifts it — and is reported
 * `blocked_by_owner:true`. Optional payload: `company` (defaults to the token),
 * `tier` (A/B/C, default B).
 */
export async function handleDiscoverAtsBoard(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const careers_url = p.careers_url as string;
  const companyArg = typeof p.company === 'string' ? p.company.trim() : '';
  const tierArg = p.tier as SourcePriority | null | undefined;

  if (!careers_url || !/^https?:\/\//i.test(careers_url)) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'careers_url must be a valid http(s) URL' },
    });
    return;
  }
  if (tierArg != null && tierArg !== 'A' && tierArg !== 'B' && tierArg !== 'C') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'tier must be A, B, or C' },
    });
    return;
  }

  try {
    // Only the URL string itself is inspected (anchored on its host, so a board
    // link inside a query string of some other site is not taken as one).
    const detected = discoverRef(careers_url);
    if (!detected) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: { ats: null, token: null, confidence: 'none', added: false, reason: 'not_a_board_link' },
      });
      return;
    }
    if (detected.region === 'eu') {
      writeResponse(inDb, requestId, {
        ok: true,
        data: {
          ats: detected.ats,
          token: detected.token,
          confidence: 'high',
          added: false,
          reason: 'eu_board_unsupported',
          message: EU_BOARD_UNSUPPORTED_MESSAGE,
        },
      });
      return;
    }

    // An owner pause, or an owner remove, is never lifted from here — only the
    // owner's own Watchlist tab does that. Answered before any fetch.
    const existing = findBoard(getDb(), detected.ats, detected.token);
    if (existing?.state === 'paused') {
      writeResponse(inDb, requestId, {
        ok: true,
        data: {
          ats: detected.ats,
          token: existing.token,
          confidence: 'high',
          added: false,
          already_listed: true,
          watchlist_id: existing.id,
          company: existing.company,
          tier: existing.tier,
          state: existing.state,
          blocked_by_owner: true,
          reason: 'blocked_by_owner',
        },
      });
      return;
    }
    if (!existing && isBoardRemoved(getDb(), detected.ats, detected.token)) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: {
          ats: detected.ats,
          token: detected.token,
          confidence: 'high',
          added: false,
          blocked_by_owner: true,
          reason: 'removed_by_owner',
          message:
            'The owner removed this board from the watchlist. Only the owner can add it back, from the admin page.',
        },
      });
      return;
    }

    // Verify through the adapter's own fixed API host before trusting the token.
    const board = await getAdapter(detected.ats).list(detected.token);
    if (!board.ok) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: {
          ats: detected.ats,
          token: detected.token,
          confidence: 'high',
          verified: false,
          added: false,
          reason: board.absent ? 'board_absent' : `board_fetch_failed: ${board.error ?? 'unknown'}`,
        },
      });
      return;
    }

    // Growth is bounded (§24.201 D7): a NEW board, or a RETIRED one being revived
    // (it rejoins the counted rows), past `ats_watchlist_max_boards` is not
    // added. An active row is still answered.
    const caps = readWatchlistCaps(getDb());
    const wouldCount = !existing || existing.state === 'absent';
    if (wouldCount && caps.counted >= caps.max_boards) {
      writeResponse(inDb, requestId, {
        ok: true,
        data: {
          ats: detected.ats,
          token: detected.token,
          confidence: 'high',
          verified: true,
          added: false,
          reason: 'watchlist_full',
          max_boards: caps.max_boards,
        },
      });
      return;
    }

    const upsert = upsertBoard(getDb(), {
      ats: detected.ats,
      token: detected.token,
      company: companyArg || detected.token,
      tier: tierArg ?? undefined,
      origin: 'owner',
      reactivate: true, // revives a retired board only; never lifts an owner's pause
    });
    if (!upsert.ok) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: { code: 'BAD_ARGS', message: `cannot add board: ${upsert.error}` },
      });
      return;
    }
    writeResponse(inDb, requestId, {
      ok: true,
      data: {
        ats: detected.ats,
        token: detected.token,
        confidence: 'high',
        verified: true,
        added: upsert.inserted,
        already_listed: !upsert.inserted,
        watchlist_id: upsert.row.id,
        company: upsert.row.company,
        tier: upsert.row.tier,
        state: upsert.row.state,
        ...(upsert.row.state === 'paused' ? { blocked_by_owner: true } : {}),
        postings_on_board: board.postings.length,
      },
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
  // Returns summaries (~150-250 bytes each) instead of full payloads — so
  // the inline-cap budget is now ~22-37KB at 150 summaries. Full payloads
  // get stashed in the payload-cache for record_job_lead to look up.
  // Default 150 / ~12 priority-A boards = ~12 per board, deep enough to
  // see past the freshest-batch sales/GTM skew on Greenhouse's
  // updated_at DESC ordering (STRATEGY.md §24.5 issue #3).
  const limit = limitRaw && limitRaw > 0 && limitRaw <= 300 ? Math.floor(limitRaw) : 150;

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
        data: {
          summaries: [],
          boards_scanned: 0,
          postings_total: 0,
          note: company
            ? `no active watchlist board for company "${company}"`
            : `no active watchlist boards with priority ${priority}`,
        },
      });
      return;
    }

    const db = getDb();
    const allSummaries: PostingSummary[] = [];
    // §24.201 D1: the same early guard the stash applies — a tombstoned or
    // title-blocklisted posting is counted by reason and NOT cached, so the
    // subagent never sees it and a record_job_lead for it is NOT_IN_CACHE.
    const rejected: Partial<Record<LeadRefusalReason, number>> = {};
    const sinceTs = since ? new Date(since).getTime() : null;
    // Distribute the total limit across boards so the result spans
    // multiple companies. Without this, the first board (e.g.,
    // Anthropic's 100+ postings) consumes the full budget and the
    // subagent never sees Stripe/Vercel/etc. Per-board cap is
    // ceil(limit / target_count), with a floor of 3 to keep small
    // scans (single-company) workable.
    const perBoardCap = Math.max(3, Math.ceil(limit / Math.max(1, targets.length)));
    let boardsFailed = 0;
    for (const target of targets) {
      const adapter = getAdapter(target.source);
      const board = await adapter.list(target.token);
      if (!board.ok) {
        // An absent or failing board contributes nothing; the sweep owns the
        // watchlist bookkeeping for it.
        boardsFailed += 1;
        continue;
      }
      let acceptedFromThisBoard = 0;
      for (const posting of board.postings) {
        // Fill in the company name from the watchlist row (adapters don't have it).
        posting.company = target.company;
        // Optional since-filter.
        if (sinceTs && posting.source_posted_at) {
          const postedTs = new Date(posting.source_posted_at).getTime();
          if (!Number.isNaN(postedTs) && postedTs < sinceTs) continue;
        }
        const guard = checkLeadGuard(db, posting);
        if (!guard.ok) {
          rejected[guard.reason] = (rejected[guard.reason] ?? 0) + 1;
          refreshLastSeenOfOpenLead(db, posting.source, posting.source_job_id);
          continue;
        }
        // Stash the full payload for record_job_lead to look up by
        // (source, source_job_id), then return only a summary to the
        // subagent. Keeps the inline-cap budget healthy regardless of
        // description length.
        payloadCache.set(posting.source, posting.source_job_id, posting);
        allSummaries.push(toSummary(posting));
        acceptedFromThisBoard += 1;
        if (acceptedFromThisBoard >= perBoardCap) break;
        if (allSummaries.length >= limit) break;
      }
      if (allSummaries.length >= limit) break;
    }
    const rejectedTotal = Object.values(rejected).reduce((a, b) => a + (b ?? 0), 0);
    if (rejectedTotal > 0) log.info('fetch_source: postings refused by insert guard', { rejected });

    writeResponse(inDb, requestId, {
      ok: true,
      data: {
        summaries: allSummaries,
        boards_scanned: targets.length,
        boards_failed: boardsFailed,
        postings_total: allSummaries.length,
        rejected,
        rejected_total: rejectedTotal,
      },
    });
  } catch (err) {
    log.error('handleFetchSource failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'FETCH_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── stash_job_payloads (§24.50) ─────────────────────────────────────────────
//
// The container-side `search_jobs` tool fetches SerpApi (OneCLI injects the
// api_key on the wire — the container never holds the key), normalizes results
// to JobLeadPayload[], and forwards them here. We stash each in the SAME 1h
// payload-cache that `fetch_source` populates (keyed by (source, source_job_id))
// and return lightweight PostingSummary[] — the exact shape `fetch_source`
// returns. The subagent then judges + records via the UNCHANGED `record_job_lead`
// path, which re-hydrates from the cache and computes fingerprint + rules_score.
// Net effect: the host stays system-of-record; only the fetch moved container-
// side (where OneCLI can inject the query-param key). Unlike `fetch_source` this
// is NOT an external fetch — it's a pure cache write, so no crawl-delay / ETag.

const STASH_MAX = 300;

export async function handleStashJobPayloads(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const payloads = p.payloads;

  if (!Array.isArray(payloads) || payloads.length === 0) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'payloads must be a non-empty array' },
    });
    return;
  }
  if (payloads.length > STASH_MAX) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `payloads capped at ${STASH_MAX} per call` },
    });
    return;
  }

  try {
    const db = getDb();
    const summaries: PostingSummary[] = [];
    let skipped = 0;
    // §24.201 D1: refused payloads are counted by reason and NOT cached, so a
    // later record_job_lead for one is NOT_IN_CACHE — the gate needs no prompt
    // cooperation from the subagent.
    const rejected: Partial<Record<LeadRefusalReason, number>> = {};
    const rejectedBySite: Record<string, number> = {};
    const accepted: JobLeadPayload[] = [];
    for (const raw of payloads as JobLeadPayload[]) {
      // Defensive: the container builds these, but a malformed entry must not
      // poison the cache or crash the stash. Require the dedup key + the fields
      // record_job_lead and toSummary read.
      if (!raw || typeof raw !== 'object') {
        skipped += 1;
        continue;
      }
      const source = raw.source;
      const sourceJobId = raw.source_job_id;
      if (
        !source ||
        !VALID_SOURCES.has(source) ||
        typeof sourceJobId !== 'string' ||
        !sourceJobId ||
        !raw.title ||
        !raw.source_url
      ) {
        skipped += 1;
        continue;
      }
      const guard = checkLeadGuard(db, raw);
      if (!guard.ok) {
        rejected[guard.reason] = (rejected[guard.reason] ?? 0) + 1;
        const site = searchPayloadSite(raw);
        if (site) rejectedBySite[site] = (rejectedBySite[site] ?? 0) + 1;
        refreshLastSeenOfOpenLead(db, source, sourceJobId);
        continue;
      }
      payloadCache.set(source, sourceJobId, raw);
      summaries.push(toSummary(raw));
      accepted.push(raw);
    }
    const rejectedTotal = Object.values(rejected).reduce((a, b) => a + (b ?? 0), 0);
    if (rejectedTotal > 0) log.info('stash_job_payloads: payloads refused by insert guard', { rejected });
    // §24.201 D7 growth: a hit whose link is already a direct ATS link yields
    // its board (origin 'search'), bounded by the watchlist caps. Boards over
    // a cap are recorded on the run row as rejected 'watchlist_cap'.
    const growth = growWatchlistFromSearchHits(db, accepted);
    if (growth.added.length > 0)
      log.info('stash_job_payloads: watchlist grew from search hits', { added: growth.added });
    const runRejected: Record<string, number> = { ...(rejected as Record<string, number>) };
    if (growth.rejected_cap > 0) runRejected.watchlist_cap = growth.rejected_cap;
    // §24.202 D6: the Leads tab's "last search" line (refusals by reason and by
    // the site each refused hit came through). Best-effort.
    recordSearchRun(db, {
      rejected: runRejected,
      rejected_by_site: rejectedBySite,
      stashed: summaries.length,
    });

    writeResponse(inDb, requestId, {
      ok: true,
      data: {
        summaries,
        stashed: summaries.length,
        skipped,
        rejected,
        rejected_total: rejectedTotal,
        boards_added: growth.added.length,
      },
    });
  } catch (err) {
    log.error('handleStashJobPayloads failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'STASH_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}
