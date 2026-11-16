/**
 * src/modules/portal/admin-watchlist.ts — the owner's Watchlist tab, the
 * sweep-filter preview and "add a lead by URL" (STRATEGY.md §24.201 D7,
 * §24.202 D6 + D7).
 *
 *   - `buildAdminWatchlist` — every board with its open-lead count, the counts
 *     and the growth caps.
 *   - `applyAdminWatchlistWriteAsync` — add a company by URL (verified through
 *     its adapter), pause / resume, remove, and the sweep-filter preview.
 *   - `applyAddLeadByUrl` — read one posting through its board's adapter and
 *     insert it as the owner's choice (title blocklist bypassed, a matching
 *     tombstone overridden and cleared); its board is PROPOSED, never added.
 *
 * The host never fetches a supplied URL: `parseAtsUrl` turns it into
 * `{ats, token, job_id?}` against fixed per-ATS hosts, and only the adapter's
 * own API base URL is called. Every route here sits under `/api/admin/`, so the
 * `adminEnabled()` gate in the API dispatch covers reads and writes. Never throws.
 */
import type Database from 'better-sqlite3';

import { hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import {
  compileSweepFilter,
  compileSweepPattern,
  evaluateSweepFilters,
  indexSearchCopies,
  type CompiledSweepFilters,
  type SweepDropReason,
} from '../career-pilot/ats-sweep.js';
import {
  ATS_URL_MAX_CHARS,
  EU_BOARD_UNSUPPORTED_MESSAGE,
  WATCHLIST_ORIGINS,
  atsJobKey,
  boardPublicUrl,
  clearBoardRemoved,
  findBoard,
  isValidBoardToken,
  markBoardRemoved,
  parseAtsUrl,
  readWatchlistCaps,
  recordBoardFetch,
  setBoardState,
  titleCaseToken,
  upsertBoard,
  type WatchlistCaps,
  type WatchlistOrigin,
  type WatchlistRow,
  type WatchlistState,
} from '../career-pilot/ats-watchlist.js';
import { upsertJobLead } from '../career-pilot/job-lead-actions.js';
import { clearMatchingTombstones } from '../career-pilot/lead-guard.js';
import { getAdapter } from '../career-pilot/scrape-jobs/sources.js';
import {
  ATS_SOURCES,
  type AtsSource,
  type JobLeadPayload,
  type SourceListResult,
  type SourcePriority,
} from '../career-pilot/scrape-jobs/types.js';

import { validateKnobWrite } from './knob-registry.js';

export type AdminWriteOutcome = { status: number; body: unknown };

/** Injectable adapter + clock (tests never touch the network). */
export interface WatchlistAdminDeps {
  getAdapter?: (ats: AtsSource) => { list(token: string): Promise<SourceListResult> };
  now?: () => Date;
}

/** Leads shown per side of the filter preview. */
export const PREVIEW_SAMPLE = 10;
const COMPANY_MAX_CHARS = 200;
const TIERS: readonly SourcePriority[] = ['A', 'B', 'C'];
const STATE_ORDER: Record<WatchlistState, number> = { active: 0, paused: 1, absent: 2 };

// ── read ───────────────────────────────────────────────────────────────────

export interface AdminWatchlistBoard extends WatchlistRow {
  /** Open leads from this board (same source, same token, not closed). */
  open_leads: number;
  /** The board's public page on its fixed ATS host (never stored, never fetched). */
  board_url: string;
}

export interface AdminWatchlistView {
  boards: AdminWatchlistBoard[];
  counts: {
    total: number;
    active: number;
    paused: number;
    absent: number;
    by_origin: Partial<Record<WatchlistOrigin, number>>;
  };
  caps: WatchlistCaps;
}

function capsOrDefaults(db: Database.Database): WatchlistCaps {
  if (hasTable(db, 'ats_watchlist')) return readWatchlistCaps(db);
  return {
    max_boards: Math.max(0, Math.floor(getConfig<number>(db, 'ats_watchlist_max_boards'))),
    counted: 0,
    max_auto_adds_per_run: Math.max(0, Math.floor(getConfig<number>(db, 'ats_watchlist_max_auto_adds_per_run'))),
  };
}

function openLeadCounts(db: Database.Database): Map<string, number> {
  const out = new Map<string, number>();
  if (!hasTable(db, 'job_leads')) return out;
  const rows = db
    .prepare(
      `SELECT source, lower(source_board_token) AS token, COUNT(*) AS n FROM job_leads
        WHERE source IN ('greenhouse', 'lever', 'ashby') AND closed_at IS NULL AND source_board_token IS NOT NULL
        GROUP BY source, lower(source_board_token)`,
    )
    .all() as Array<{ source: string; token: string; n: number }>;
  for (const r of rows) out.set(`${r.source}:${r.token}`, r.n);
  return out;
}

function toBoardView(row: WatchlistRow, open: Map<string, number>): AdminWatchlistBoard {
  return {
    ...row,
    open_leads: open.get(`${row.ats}:${row.token.toLowerCase()}`) ?? 0,
    board_url: boardPublicUrl(row.ats, row.token),
  };
}

function boardById(db: Database.Database, id: number): WatchlistRow | undefined {
  return db.prepare('SELECT * FROM ats_watchlist WHERE id = ?').get(id) as WatchlistRow | undefined;
}

function boardViewById(db: Database.Database, id: number): AdminWatchlistBoard | null {
  const row = boardById(db, id);
  return row ? toBoardView(row, openLeadCounts(db)) : null;
}

export function buildAdminWatchlist(db: Database.Database): AdminWatchlistView {
  const empty: AdminWatchlistView = {
    boards: [],
    counts: { total: 0, active: 0, paused: 0, absent: 0, by_origin: {} },
    caps: capsOrDefaults(db),
  };
  if (!hasTable(db, 'ats_watchlist')) return empty;
  // Reading through findBoard/readWatchlistCaps already ran the lazy seed.
  const rows = db.prepare('SELECT * FROM ats_watchlist').all() as WatchlistRow[];
  const open = openLeadCounts(db);
  const boards = rows
    .map((r) => toBoardView(r, open))
    .sort(
      (a, b) =>
        (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
        a.tier.localeCompare(b.tier) ||
        a.company.localeCompare(b.company) ||
        a.id - b.id,
    );
  const counts = empty.counts;
  for (const b of boards) {
    counts.total += 1;
    if (b.state === 'active' || b.state === 'paused' || b.state === 'absent') counts[b.state] += 1;
    if (WATCHLIST_ORIGINS.includes(b.origin)) counts.by_origin[b.origin] = (counts.by_origin[b.origin] ?? 0) + 1;
  }
  return { boards, counts, caps: empty.caps };
}

// ── shared input checks ────────────────────────────────────────────────────

/** `company` when given: a trimmed 1..200-char string. undefined/null → not given. */
function parseCompany(v: unknown): { ok: true; company: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, company: null };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (!t || t.length > COMPANY_MAX_CHARS) return { ok: false };
  return { ok: true, company: t };
}

function parseUrlField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= ATS_URL_MAX_CHARS ? t : null;
}

function adapterFor(deps: WatchlistAdminDeps, ats: AtsSource) {
  return (deps.getAdapter ?? getAdapter)(ats);
}

async function listBoard(deps: WatchlistAdminDeps, ats: AtsSource, token: string): Promise<SourceListResult> {
  try {
    return await adapterFor(deps, ats).list(token);
  } catch (err) {
    return {
      ok: false,
      absent: false,
      postings: [],
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function boardFailure(res: SourceListResult): AdminWriteOutcome {
  if (res.absent) {
    return {
      status: 404,
      body: { error: 'board_not_found', message: 'The ATS says that board does not exist.' },
    };
  }
  return {
    status: 502,
    body: {
      error: 'adapter_failed',
      message: `The ATS did not answer: ${res.error ?? 'request failed'}`,
      status: res.status ?? null,
    },
  };
}

// ── writes ─────────────────────────────────────────────────────────────────

/**
 * `POST /api/admin/watchlist` — `{action}` one of `add_by_url`, `set_state`,
 * `remove`, `preview_filters`. Async because `add_by_url` verifies the board
 * through its adapter. Never throws.
 */
export async function applyAdminWatchlistWriteAsync(
  db: Database.Database,
  raw: unknown,
  deps: WatchlistAdminDeps = {},
): Promise<AdminWriteOutcome> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { status: 400, body: { error: 'expected a JSON object { action }' } };
  }
  const body = raw as Record<string, unknown>;
  try {
    switch (body.action) {
      case 'add_by_url':
        if (!hasTable(db, 'ats_watchlist')) return { status: 404, body: { error: 'ats_watchlist not migrated' } };
        return await addBoardByUrl(db, body, deps);
      case 'set_state':
        if (!hasTable(db, 'ats_watchlist')) return { status: 404, body: { error: 'ats_watchlist not migrated' } };
        return setState(db, body);
      case 'remove':
        if (!hasTable(db, 'ats_watchlist')) return { status: 404, body: { error: 'ats_watchlist not migrated' } };
        return removeBoard(db, body);
      case 'preview_filters':
        if (!hasTable(db, 'job_leads')) return { status: 404, body: { error: 'job_leads not migrated' } };
        return previewSweepFilters(db, body.filters, (deps.now ?? (() => new Date()))());
      default:
        return { status: 400, body: { error: `unknown action: ${String(body.action)}` } };
    }
  } catch (err) {
    log.error('admin watchlist write failed', { err: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: { error: 'internal_error' } };
  }
}

async function addBoardByUrl(
  db: Database.Database,
  body: Record<string, unknown>,
  deps: WatchlistAdminDeps,
): Promise<AdminWriteOutcome> {
  const url = parseUrlField(body.url);
  if (!url) return { status: 400, body: { error: 'url_required', message: 'Paste a board or job link.' } };
  const ref = parseAtsUrl(url);
  if (!ref) {
    return {
      status: 400,
      body: {
        error: 'not_board_url',
        message: 'Only Greenhouse, Lever and Ashby links can be added. Other career sites are not fetched.',
      },
    };
  }
  // No adapter calls the EU API hosts, so an EU board could never be read.
  if (ref.region === 'eu')
    return { status: 400, body: { error: 'not_board_url', message: EU_BOARD_UNSUPPORTED_MESSAGE } };
  if (!isValidBoardToken(ref.token)) {
    return { status: 400, body: { error: 'bad_token', message: "That link's board name is not valid." } };
  }
  const company = parseCompany(body.company);
  if (!company.ok) return { status: 400, body: { error: 'bad_company' } };
  if (body.tier !== undefined && body.tier !== null && !TIERS.includes(body.tier as SourcePriority)) {
    return { status: 400, body: { error: 'bad_tier' } };
  }
  const tier = (body.tier ?? undefined) as SourcePriority | undefined;

  const existing = findBoard(db, ref.ats, ref.token);
  if (existing && existing.state !== 'absent') {
    return { status: 409, body: { error: 'already_listed', board: boardViewById(db, existing.id) } };
  }
  // A retired row being revived counts toward the cap exactly like a new one.
  const caps = readWatchlistCaps(db);
  if (caps.counted >= caps.max_boards) {
    return { status: 409, body: { error: 'cap_reached', cap: caps.max_boards, counted: caps.counted } };
  }

  const res = await listBoard(deps, ref.ats, ref.token);
  if (!res.ok) return boardFailure(res);

  const now = (deps.now ?? (() => new Date()))();
  // The owner adding it back is the one thing that lifts their earlier remove.
  clearBoardRemoved(db, ref.ats, ref.token);
  if (existing) {
    setBoardState(db, existing.id, 'active');
    recordBoardFetch(db, existing.id, { ok: true, absent: false, newLeads: 0 }, now);
    log.info('admin: retired watchlist board reactivated by URL', { ats: ref.ats, token: existing.token });
    return {
      status: 200,
      body: { ok: true, board: boardViewById(db, existing.id), inserted: false, reactivated: true },
    };
  }
  const up = upsertBoard(db, {
    ats: ref.ats,
    token: ref.token,
    company: company.company ?? (titleCaseToken(ref.token) || ref.token),
    tier,
    origin: 'owner',
  });
  if (!up.ok) return { status: 400, body: { error: up.error } };
  recordBoardFetch(db, up.row.id, { ok: true, absent: false, newLeads: 0 }, now);
  log.info('admin: watchlist board added by URL', { ats: ref.ats, token: ref.token });
  return {
    status: 200,
    body: { ok: true, board: boardViewById(db, up.row.id), inserted: up.inserted, reactivated: false },
  };
}

function parseId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function setState(db: Database.Database, body: Record<string, unknown>): AdminWriteOutcome {
  const id = parseId(body.id);
  if (id === null) return { status: 400, body: { error: 'bad_id' } };
  const state = body.state;
  if (state !== 'active' && state !== 'paused') return { status: 400, body: { error: 'bad_state' } };
  const row = boardById(db, id);
  if (!row) return { status: 404, body: { error: 'not_found', id } };
  if (state === 'active' && row.state === 'absent') {
    const caps = readWatchlistCaps(db);
    if (caps.counted >= caps.max_boards) {
      return { status: 409, body: { error: 'cap_reached', cap: caps.max_boards, counted: caps.counted } };
    }
  }
  // Activating resets both streaks (setBoardState). This is the only path that
  // undoes an owner pause — the agent's discover keeps answering blocked_by_owner.
  setBoardState(db, id, state);
  log.info('admin: watchlist board state set', { id, from: row.state, to: state });
  return { status: 200, body: { ok: true, board: boardViewById(db, id) } };
}

function removeBoard(db: Database.Database, body: Record<string, unknown>): AdminWriteOutcome {
  const id = parseId(body.id);
  if (id === null) return { status: 400, body: { error: 'bad_id' } };
  const row = boardById(db, id);
  if (!row) return { status: 404, body: { error: 'not_found', id } };
  if (row.origin === 'seed') {
    return {
      status: 409,
      body: {
        error: 'seed_board',
        message: 'This board comes from the seed list and would come back on the next restart. Pause it instead.',
      },
    };
  }
  // Remembered, so neither automatic growth (a search hit's board, "I applied")
  // nor the agent's discover adds it back; re-adding it by URL clears the record.
  db.transaction(() => {
    db.prepare('DELETE FROM ats_watchlist WHERE id = ?').run(id);
    markBoardRemoved(db, row.ats, row.token);
  })();
  log.info('admin: watchlist board removed', { id, ats: row.ats, token: row.token });
  return { status: 200, body: { ok: true, id, removed: true } };
}

// ── the sweep-filter preview ───────────────────────────────────────────────

const PATTERN_KEYS = ['ats_sweep_title_include', 'ats_sweep_title_exclude', 'ats_sweep_location_filter'] as const;
const PREVIEW_KEYS: readonly string[] = [...PATTERN_KEYS, 'ats_sweep_max_age_days'];

export interface SweepFilterCounts {
  keep: number;
  drop: number;
  drop_by_reason: Partial<Record<SweepDropReason, number>>;
}

export interface SweepPreviewLead {
  id: string;
  title: string;
  company: string;
  reason: SweepDropReason | null;
}

export interface SweepFilterPreview {
  ok: true;
  total: number;
  current: SweepFilterCounts;
  proposed: SweepFilterCounts;
  newly_dropped: number;
  newly_kept: number;
  sample_newly_dropped: SweepPreviewLead[];
  sample_newly_kept: SweepPreviewLead[];
}

function storedFilters(db: Database.Database): CompiledSweepFilters {
  return {
    include: compileSweepFilter(db, 'ats_sweep_title_include').re,
    exclude: compileSweepFilter(db, 'ats_sweep_title_exclude').re,
    location: compileSweepFilter(db, 'ats_sweep_location_filter').re,
    maxAgeDays: getConfig<number>(db, 'ats_sweep_max_age_days'),
  };
}

/**
 * What the proposed sweep filters would keep among the OPEN board leads, next
 * to what the stored filters keep — using `evaluateSweepFilters`, the very
 * function the sweep runs. Read-only. An estimate by design: the sweep filters
 * only NEW postings and never re-filters the pool, and the per-run cap is not
 * modelled.
 */
export function previewSweepFilters(db: Database.Database, rawFilters: unknown, now: Date): AdminWriteOutcome {
  if (typeof rawFilters !== 'object' || rawFilters === null || Array.isArray(rawFilters)) {
    return { status: 400, body: { error: 'invalid_filter', field: 'filters', message: 'expected an object' } };
  }
  const current = storedFilters(db);
  const proposed: CompiledSweepFilters = { ...current };
  for (const [key, value] of Object.entries(rawFilters as Record<string, unknown>)) {
    if (!PREVIEW_KEYS.includes(key)) {
      return { status: 400, body: { error: 'invalid_filter', field: key, message: 'not a sweep filter' } };
    }
    const v = validateKnobWrite(key, value);
    if (!v.ok) return { status: 400, body: { error: 'invalid_filter', field: key, message: v.error ?? 'invalid' } };
    if (key === 'ats_sweep_max_age_days') {
      proposed.maxAgeDays = Number(v.value);
      continue;
    }
    const re = compileSweepPattern(key, v.value).re;
    if (key === 'ats_sweep_title_include') proposed.include = re;
    else if (key === 'ats_sweep_title_exclude') proposed.exclude = re;
    else proposed.location = re;
  }

  const ph = ATS_SOURCES.map(() => '?').join(', ');
  const leads = db
    .prepare(
      `SELECT id, title, company, location_raw, workplace_type, source_posted_at FROM job_leads
        WHERE source IN (${ph}) AND closed_at IS NULL ORDER BY first_seen_at DESC`,
    )
    .all(...ATS_SOURCES) as Array<{
    id: string;
    title: string | null;
    company: string | null;
    location_raw: string | null;
    workplace_type: string | null;
    source_posted_at: string | null;
  }>;

  const counts = (): SweepFilterCounts => ({ keep: 0, drop: 0, drop_by_reason: {} });
  const out: SweepFilterPreview = {
    ok: true,
    total: leads.length,
    current: counts(),
    proposed: counts(),
    newly_dropped: 0,
    newly_kept: 0,
    sample_newly_dropped: [],
    sample_newly_kept: [],
  };
  const tally = (c: SweepFilterCounts, reason: SweepDropReason | null): void => {
    if (reason === null) {
      c.keep += 1;
      return;
    }
    c.drop += 1;
    c.drop_by_reason[reason] = (c.drop_by_reason[reason] ?? 0) + 1;
  };
  for (const lead of leads) {
    const before = evaluateSweepFilters(lead, current, now);
    const after = evaluateSweepFilters(lead, proposed, now);
    tally(out.current, before);
    tally(out.proposed, after);
    const brief = { id: lead.id, title: lead.title ?? '', company: lead.company ?? '' };
    if (before === null && after !== null) {
      out.newly_dropped += 1;
      if (out.sample_newly_dropped.length < PREVIEW_SAMPLE) out.sample_newly_dropped.push({ ...brief, reason: after });
    } else if (before !== null && after === null) {
      out.newly_kept += 1;
      if (out.sample_newly_kept.length < PREVIEW_SAMPLE) out.sample_newly_kept.push({ ...brief, reason: null });
    }
  }
  return { status: 200, body: out };
}

// ── add a lead by URL (§24.202 D7) ─────────────────────────────────────────

export interface BoardProposal {
  ats: AtsSource;
  token: string;
  company: string;
  already_listed: boolean;
  state: WatchlistState | null;
}

function proposeBoard(db: Database.Database, ats: AtsSource, token: string, company: string): BoardProposal {
  const row = hasTable(db, 'ats_watchlist') ? findBoard(db, ats, token) : undefined;
  return {
    ats,
    token: row?.token ?? token,
    company: row?.company ?? company,
    already_listed: !!row,
    state: row?.state ?? null,
  };
}

/** The lead already in the pool for this posting: the board row itself, or a
 *  search hit whose link is the same ATS job (one job, two sources). */
function findExistingLead(
  db: Database.Database,
  ats: AtsSource,
  token: string,
  jobId: string,
): { id: string; status: string } | undefined {
  const own = db
    .prepare('SELECT id, status FROM job_leads WHERE source = ? AND lower(source_job_id) = lower(?) LIMIT 1')
    .get(ats, jobId) as { id: string; status: string } | undefined;
  if (own) return own;
  const copies = indexSearchCopies(db).get(atsJobKey(ats, token, jobId));
  if (!copies || copies.length === 0) return undefined;
  return db.prepare('SELECT id, status FROM job_leads WHERE id = ?').get(copies[0]) as
    | { id: string; status: string }
    | undefined;
}

/**
 * `{ action: 'add_lead_by_url', url, company? }` on the leads write. The posting
 * is read through its board's adapter (the URL is never fetched) and inserted as
 * `source=<ats>`, `apply_link_kind='ats'` — the owner chose it, so the sweep's
 * title filter and the title blocklist do not apply and any tombstone matching
 * it is deleted first. Its board is proposed to the watchlist, never added.
 */
export async function applyAddLeadByUrl(
  db: Database.Database,
  body: Record<string, unknown>,
  deps: WatchlistAdminDeps = {},
): Promise<AdminWriteOutcome> {
  if (!hasTable(db, 'job_leads')) return { status: 404, body: { error: 'job_leads not migrated' } };
  const url = parseUrlField(body.url);
  if (!url) return { status: 400, body: { error: 'url_required', message: 'Paste a job posting link.' } };
  const ref = parseAtsUrl(url);
  if (!ref) {
    return {
      status: 400,
      body: {
        error: 'not_posting_url',
        message: 'Only Greenhouse, Lever and Ashby job links can be added. Other sites are not fetched.',
      },
    };
  }
  if (!ref.job_id) {
    return {
      status: 400,
      body: {
        error: 'not_posting_url',
        message: 'That is a board link, not a job posting. Add the board on the Watchlist tab instead.',
      },
    };
  }
  if (ref.region === 'eu') {
    return { status: 400, body: { error: 'not_posting_url', message: EU_BOARD_UNSUPPORTED_MESSAGE } };
  }
  if (!isValidBoardToken(ref.token)) {
    return { status: 400, body: { error: 'bad_token', message: "That link's board name is not valid." } };
  }
  const company = parseCompany(body.company);
  if (!company.ok) return { status: 400, body: { error: 'bad_company' } };
  const jobId = ref.job_id;

  try {
    const listed = hasTable(db, 'ats_watchlist') ? findBoard(db, ref.ats, ref.token) : undefined;
    const companyName = listed?.company ?? company.company ?? (titleCaseToken(ref.token) || ref.token);

    const existing = findExistingLead(db, ref.ats, ref.token, jobId);
    if (existing) {
      return {
        status: 200,
        body: {
          ok: true,
          lead_id: existing.id,
          outcome: 'already_present',
          lead_status: existing.status,
          tombstone_cleared: false,
          board_proposed: proposeBoard(db, ref.ats, ref.token, companyName),
        },
      };
    }

    const res = await listBoard(deps, ref.ats, ref.token);
    if (!res.ok) return boardFailure(res);
    const found = res.postings.find((p) => p.source_job_id.toLowerCase() === jobId.toLowerCase());
    if (!found) {
      return {
        status: 404,
        body: { error: 'posting_not_found', message: 'That posting is not on the board any more.' },
      };
    }

    const posting: JobLeadPayload = {
      ...found,
      company: companyName,
      source_board_token: found.source_board_token ?? ref.token,
      apply_link_kind: 'ats',
    };
    let cleared = { deleted: 0, overridden: 0 };
    const result = db.transaction(() => {
      // The owner chose this posting: its own tombstones are deleted, and a
      // fingerprint tombstone of ANOTHER posting is skipped for this insert only
      // (it keeps refusing the posting it was written for).
      cleared = clearMatchingTombstones(db, posting);
      return upsertJobLead(db, posting, { ownerChosen: true });
    })();
    if (!result.recorded) {
      return { status: 409, body: { error: 'refused', reason: result.reason, message: result.detail } };
    }
    const row = db.prepare('SELECT status FROM job_leads WHERE id = ?').get(result.id) as { status: string };
    log.info('admin: lead added by URL', {
      id: result.id,
      ats: ref.ats,
      token: ref.token,
      tombstones_deleted: cleared.deleted,
      tombstones_overridden: cleared.overridden,
    });
    return {
      status: 200,
      body: {
        ok: true,
        lead_id: result.id,
        outcome: result.inserted_or_updated === 'inserted' ? 'created' : 'already_present',
        lead_status: row.status,
        tombstone_cleared: cleared.deleted > 0 || cleared.overridden > 0,
        board_proposed: proposeBoard(db, ref.ats, ref.token, companyName),
      },
    };
  } catch (err) {
    log.error('admin: add lead by URL failed', { err: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: { error: 'internal_error' } };
  }
}
