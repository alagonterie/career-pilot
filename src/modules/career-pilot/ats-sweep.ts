/**
 * src/modules/career-pilot/ats-sweep.ts — the direct employer-board sweep
 * (STRATEGY.md §24.200 D5, D6c; §24.201 D6 "Sweep now").
 *
 * Host-side, deterministic and LLM-free. For every `active` watchlist board it
 * lists the board through its adapter and then, on an `ok` fetch:
 *   - reopens leads closed as `absent` that are back, stamps `last_seen_at` on
 *     every known open lead still on the board, and closes the ones that are gone
 *     (`applyBoardPresence` — a suspect empty response closes nothing, a promoted
 *     / applied / queued lead is never closed, a queued one is surfaced);
 *   - for postings the pool has never seen, applies the title include/exclude,
 *     location and age filters, then hands the survivors to `upsertJobLead` (the
 *     shared insert guard refuses tombstoned / blocklisted postings), capped at
 *     `ats_sweep_max_new_per_run` across the run.
 * A failed fetch closes nothing; an absent board closes nothing and feeds the
 * board's absent streak (`recordBoardFetch` retires it past
 * `ats_watchlist_retire_after` "board gone" answers — a transient failure never
 * retires a board). A posting already in the pool as a search hit (same ATS job
 * by URL) is refreshed, not inserted again. A run with active boards where no
 * board fetched ok is recorded as failed (ok=0), so an outage reads as stale.
 *
 * Every run writes one `lead_source_runs` row (kind 'sweep'). Runs are
 * single-flight per process and never start under `halted` / `killswitch`.
 *
 * Scheduling: `maybeStartScheduledSweep` is called from the host sweep tick. It
 * is synchronous, cheap and never awaits the sweep — the run is detached. It
 * fires when the newest sweep started before the most recent `ats_sweep_cron`
 * occurrence, so however many occurrences were missed (a standby, a restart),
 * a resume fires exactly ONE catch-up run, never a burst.
 */
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { getPauseState } from '../portal/system-modes.js';

import { atsJobKey, listActiveBoards, parseAtsJobUrl, recordBoardFetch, type WatchlistRow } from './ats-watchlist.js';
import { applyBoardPresence, upsertJobLead } from './job-lead-actions.js';
import { getAdapter } from './scrape-jobs/sources.js';
import type { AtsSource, JobLeadPayload, SourceListResult } from './scrape-jobs/types.js';

export type SweepTrigger = 'schedule' | 'manual';

export interface FailingBoard {
  company: string;
  ats: string;
  error: string;
}

/** What one finished sweep did — the `lead_source_runs` row, as counts. */
export interface SweepRunResult {
  id: string;
  trigger: SweepTrigger;
  started_at: string;
  finished_at: string;
  ok: boolean;
  error: string | null;
  boards_ok: number;
  boards_failed: number;
  new: number;
  refreshed: number;
  closed: number;
  reopened: number;
  rejected: Record<string, number>;
  failing_boards: FailingBoard[];
  queued_absent: Array<{ id: string; title: string; company: string }>;
}

export type SweepStartRefusal = 'already_running' | 'halted' | 'not_migrated';

export interface SweepDeps {
  /** Lists one board. Defaults to the real adapter; tests inject fixtures. */
  listBoard?: (ats: AtsSource, token: string) => Promise<SourceListResult>;
  /** Clock (tests). */
  now?: () => Date;
}

// ── single flight ──────────────────────────────────────────────────────────

let inFlight: Promise<SweepRunResult> | null = null;

/** True while a sweep is running in this process. */
export function isSweepRunning(): boolean {
  return inFlight !== null;
}

/** Test seam: await the in-flight sweep (resolves to null when none). */
export async function _awaitInFlightSweepForTesting(): Promise<SweepRunResult | null> {
  return inFlight ? inFlight : null;
}

function refusalFor(db: Database.Database): SweepStartRefusal | null {
  if (inFlight) return 'already_running';
  const pause = getPauseState();
  if (pause === 'halted' || pause === 'killswitch') return 'halted';
  if (!hasTable(db, 'lead_source_runs') || !hasTable(db, 'ats_watchlist')) return 'not_migrated';
  return null;
}

/**
 * Start a sweep without waiting for it (what `/admin` "Sweep now" and the
 * scheduler call). Synchronous: the refusal or the start is decided before it
 * returns. Never throws.
 */
export function startSweep(
  db: Database.Database,
  opts: { trigger: SweepTrigger },
  deps: SweepDeps = {},
): { started: true } | { started: false; reason: SweepStartRefusal } {
  let refusal: SweepStartRefusal | null;
  try {
    refusal = refusalFor(db);
  } catch (err) {
    log.warn('ats sweep: start check failed', { err: err instanceof Error ? err.message : String(err) });
    return { started: false, reason: 'not_migrated' };
  }
  if (refusal) return { started: false, reason: refusal };
  const run = runSweep(db, opts.trigger, deps);
  inFlight = run;
  void run
    .catch((err) => {
      log.error('ats sweep: run failed', { err: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      if (inFlight === run) inFlight = null;
    });
  return { started: true };
}

/**
 * Run one sweep and wait for it. Single-flight: returns `{status:'already_running'}`
 * while another sweep runs, `{status:'halted'}` under halted / killswitch.
 */
export async function sweepWatchlist(
  db: Database.Database,
  opts: { trigger: SweepTrigger },
  deps: SweepDeps = {},
): Promise<{ status: 'done'; run: SweepRunResult } | { status: SweepStartRefusal }> {
  const start = startSweep(db, opts, deps);
  if (!start.started) return { status: start.reason };
  const run = await (inFlight as Promise<SweepRunResult>);
  return { status: 'done', run };
}

// ── filters ────────────────────────────────────────────────────────────────

interface CompiledFilter {
  re: RegExp | null;
  error: string | null;
}

/** Compile a stored filter knob. Empty → no filter. A pattern that does not
 *  compile (saved before validation existed, or written around it) is skipped
 *  and reported — it must never crash the sweep. */
export function compileSweepFilter(db: Database.Database, key: string): CompiledFilter {
  let src: unknown;
  try {
    src = getConfig<string>(db, key);
  } catch (err) {
    return { re: null, error: `${key}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof src !== 'string' || src.trim() === '') return { re: null, error: null };
  try {
    return { re: new RegExp(src, 'i'), error: null };
  } catch (err) {
    return {
      re: null,
      error: `${key} does not compile (filter skipped): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

const ID_CHUNK = 500;

/** The subset of `ids` already in job_leads for `source` (any state). */
function knownIds(db: Database.Database, source: AtsSource, ids: readonly string[]): Set<string> {
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK);
    const ph = part.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT source_job_id FROM job_leads WHERE source = ? AND source_job_id IN (${ph})`)
      .all(source, ...part) as Array<{ source_job_id: string }>;
    for (const r of rows) known.add(r.source_job_id);
  }
  return known;
}

/**
 * Search hits already in the pool (source 'google_jobs', any state) whose apply
 * or source URL IS a board posting, keyed by `atsJobKey` → lead ids. A board
 * posting with a search copy is treated as known: the sweep refreshes the copy
 * instead of inserting the same job a second time, so the owner's triage of the
 * copy (archived, not interested, queued) carries over and killer-match cannot
 * alert twice for one job. Built once per run — the sweep never writes
 * google_jobs rows, so it cannot go stale mid-run.
 */
export function indexSearchCopies(db: Database.Database): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT id, apply_url, source_url FROM job_leads
        WHERE source = 'google_jobs'
          AND (apply_url LIKE '%greenhouse.io%' OR apply_url LIKE '%lever.co%' OR apply_url LIKE '%ashbyhq.com%'
               OR source_url LIKE '%greenhouse.io%' OR source_url LIKE '%lever.co%' OR source_url LIKE '%ashbyhq.com%')`,
    )
    .all() as Array<{ id: string; apply_url: string | null; source_url: string | null }>;
  const index = new Map<string, string[]>();
  for (const r of rows) {
    const keys = new Set<string>();
    for (const url of [r.apply_url, r.source_url]) {
      const ref = parseAtsJobUrl(url);
      if (ref) keys.add(atsJobKey(ref.ats, ref.token, ref.job_id));
    }
    for (const k of keys) index.set(k, [...(index.get(k) ?? []), r.id]);
  }
  return index;
}

/** Stamp last_seen_at on the OPEN leads among `ids`; returns how many. */
function refreshOpenLeads(db: Database.Database, ids: readonly string[], now: Date): number {
  const stmt = db.prepare('UPDATE job_leads SET last_seen_at = ? WHERE id = ? AND closed_at IS NULL');
  let n = 0;
  for (const id of ids) n += stmt.run(now.toISOString(), id).changes;
  return n;
}

// ── the run ────────────────────────────────────────────────────────────────

function newRunId(): string {
  return `sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runSweep(db: Database.Database, trigger: SweepTrigger, deps: SweepDeps): Promise<SweepRunResult> {
  const clock = deps.now ?? (() => new Date());
  const listBoard = deps.listBoard ?? ((ats: AtsSource, token: string) => getAdapter(ats).list(token));
  const startedAt = clock();
  const run: SweepRunResult = {
    id: newRunId(),
    trigger,
    started_at: startedAt.toISOString(),
    finished_at: startedAt.toISOString(),
    ok: false,
    error: null,
    boards_ok: 0,
    boards_failed: 0,
    new: 0,
    refreshed: 0,
    closed: 0,
    reopened: 0,
    rejected: {},
    failing_boards: [],
    queued_absent: [],
  };
  db.prepare(
    `INSERT INTO lead_source_runs (id, kind, trigger, started_at) VALUES (@id, 'sweep', @trigger, @started_at)`,
  ).run({ id: run.id, trigger, started_at: run.started_at });

  const errors: string[] = [];
  try {
    const include = compileSweepFilter(db, 'ats_sweep_title_include');
    const exclude = compileSweepFilter(db, 'ats_sweep_title_exclude');
    const location = compileSweepFilter(db, 'ats_sweep_location_filter');
    for (const f of [include, exclude, location]) if (f.error) errors.push(f.error);
    const maxAgeDays = getConfig<number>(db, 'ats_sweep_max_age_days');
    const maxNew = Math.max(0, Math.floor(getConfig<number>(db, 'ats_sweep_max_new_per_run')));

    const searchCopies = indexSearchCopies(db);
    const boards = listActiveBoards(db);
    for (const board of boards) {
      await sweepBoard(db, board, listBoard, clock, run, {
        include,
        exclude,
        location,
        maxAgeDays,
        maxNew,
        searchCopies,
      });
    }
    // A run that reached no board at all did not succeed: health and the
    // /architecture probe read freshness from ok=1, and an egress or vendor
    // outage must read as down, not as a fresh sweep. (No active boards → ok.)
    if (boards.length > 0 && run.boards_ok === 0) {
      run.ok = false;
      errors.push(`every board fetch failed (${run.boards_failed} of ${boards.length})`);
    } else {
      run.ok = true;
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    run.ok = false;
    log.error('ats sweep: aborted', { id: run.id, err: errors[errors.length - 1] });
  }

  run.error = errors.length > 0 ? errors.join('; ').slice(0, 1000) : null;
  run.finished_at = clock().toISOString();
  try {
    db.prepare(
      `UPDATE lead_source_runs
          SET finished_at = @finished_at, ok = @ok, error = @error,
              boards_ok = @boards_ok, boards_failed = @boards_failed,
              new_count = @new, refreshed_count = @refreshed, closed_count = @closed, reopened_count = @reopened,
              rejected_json = @rejected, failing_boards_json = @failing, queued_absent_json = @queued
        WHERE id = @id`,
    ).run({
      id: run.id,
      finished_at: run.finished_at,
      ok: run.ok ? 1 : 0,
      error: run.error,
      boards_ok: run.boards_ok,
      boards_failed: run.boards_failed,
      new: run.new,
      refreshed: run.refreshed,
      closed: run.closed,
      reopened: run.reopened,
      rejected: JSON.stringify(run.rejected),
      failing: JSON.stringify(run.failing_boards),
      queued: JSON.stringify(run.queued_absent),
    });
  } catch (err) {
    log.error('ats sweep: could not write the run row', { id: run.id, err });
  }
  log.info('ats sweep: finished', {
    id: run.id,
    trigger,
    ok: run.ok,
    boards_ok: run.boards_ok,
    boards_failed: run.boards_failed,
    new: run.new,
    refreshed: run.refreshed,
    closed: run.closed,
    reopened: run.reopened,
    rejected: run.rejected,
  });
  return run;
}

interface SweepFilters {
  include: CompiledFilter;
  exclude: CompiledFilter;
  location: CompiledFilter;
  maxAgeDays: number;
  maxNew: number;
  /** `indexSearchCopies` for this run. */
  searchCopies: Map<string, string[]>;
}

async function sweepBoard(
  db: Database.Database,
  board: WatchlistRow,
  listBoard: (ats: AtsSource, token: string) => Promise<SourceListResult>,
  clock: () => Date,
  run: SweepRunResult,
  f: SweepFilters,
): Promise<void> {
  const ats = board.ats;
  let res: SourceListResult;
  try {
    res = await listBoard(ats, board.token);
  } catch (err) {
    res = { ok: false, absent: false, postings: [], error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    // A failed fetch and an absent board close nothing; both extend the
    // board's failure streak (an absent board is retired past the limit).
    run.boards_failed += 1;
    const error = res.absent ? `board absent${res.error ? ` (${res.error})` : ''}` : (res.error ?? 'fetch failed');
    run.failing_boards.push({ company: board.company, ats, error });
    recordBoardFetch(db, board.id, { ok: false, absent: res.absent, error: res.error ?? null }, clock());
    return;
  }

  run.boards_ok += 1;
  const now = clock();
  // Presence uses the board's FULL id list — a filtered-out posting is still on it.
  const presentIds = res.postings.map((p) => p.source_job_id);
  const presence = applyBoardPresence(db, ats, board.token, presentIds, now);
  run.refreshed += presence.refreshed;
  run.closed += presence.closed.length;
  run.reopened += presence.reopened.length;
  run.queued_absent.push(...presence.queued);
  if (presence.suspect) {
    // Fetched fine but empty while the pool holds open leads from it: treated as
    // a bad response (nothing closed) and surfaced so the owner can look.
    run.failing_boards.push({ company: board.company, ats, error: 'returned no postings; nothing closed' });
  }

  const known = knownIds(db, ats, presentIds);
  const ageCutoff = now.getTime() - f.maxAgeDays * 86_400_000;
  let newForBoard = 0;
  for (const raw of res.postings) {
    if (known.has(raw.source_job_id)) continue;
    const copies = f.searchCopies.get(atsJobKey(ats, board.token, raw.source_job_id));
    if (copies) {
      // The same job is already in the pool as a search hit: known, not new.
      run.refreshed += refreshOpenLeads(db, copies, now);
      continue;
    }
    const posting: JobLeadPayload = { ...raw, company: board.company };
    const title = posting.title ?? '';
    if (f.include.re && !f.include.re.test(title)) {
      bump(run.rejected, 'filter');
      continue;
    }
    if (f.exclude.re && f.exclude.re.test(title)) {
      bump(run.rejected, 'filter');
      continue;
    }
    if (f.location.re) {
      const where = [posting.location_raw, posting.workplace_type].filter(Boolean).join(' | ');
      if (!f.location.re.test(where)) {
        bump(run.rejected, 'location');
        continue;
      }
    }
    if (posting.source_posted_at) {
      const posted = Date.parse(posting.source_posted_at);
      if (Number.isFinite(posted) && posted < ageCutoff) {
        bump(run.rejected, 'age');
        continue;
      }
    }
    if (run.new >= f.maxNew) {
      bump(run.rejected, 'cap');
      continue;
    }
    const result = upsertJobLead(db, posting);
    if (!result.recorded) {
      bump(run.rejected, result.reason);
      continue;
    }
    if (result.inserted_or_updated === 'inserted') {
      run.new += 1;
      newForBoard += 1;
    }
  }
  recordBoardFetch(db, board.id, { ok: true, absent: false, newLeads: newForBoard }, now);
}

// ── scheduling ─────────────────────────────────────────────────────────────

/**
 * Whether a scheduled sweep is due (pure): the newest sweep started before the
 * most recent occurrence of `cron` at or before `now`. Missed occurrences
 * collapse into one — the condition is cleared by the single run it starts.
 * An unparseable cron is never due.
 */
export function isScheduledSweepDue(
  cron: string,
  lastStartedAt: string | null,
  now: Date,
  tz: string = TIMEZONE,
): boolean {
  let prevFire: number;
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: now, tz });
    prevFire = it.prev().getTime();
  } catch {
    return false;
  }
  if (!lastStartedAt) return true;
  const last = Date.parse(lastStartedAt);
  if (!Number.isFinite(last)) return true;
  return last < prevFire;
}

let interruptedRowsSettled = false;

/** Test seam: forget that orphaned run rows were already settled. */
export function _resetSweepSchedulerForTesting(): void {
  interruptedRowsSettled = false;
}

/**
 * A run row left with `ok IS NULL` by a process that died mid-sweep would read
 * as "running" forever; settle those as failed once per process, before the
 * first scheduled check (never while this process has a sweep in flight).
 */
function settleInterruptedRuns(db: Database.Database, now: Date): void {
  if (interruptedRowsSettled || inFlight) return;
  interruptedRowsSettled = true;
  const n = db
    .prepare(
      `UPDATE lead_source_runs SET ok = 0, error = 'interrupted (host restarted mid-sweep)', finished_at = ?
        WHERE kind = 'sweep' AND ok IS NULL`,
    )
    .run(now.toISOString()).changes;
  if (n > 0) log.warn('ats sweep: settled interrupted run rows', { count: n });
}

/**
 * Called on every host sweep tick. Synchronous and cheap; never throws; never
 * awaits the sweep it starts. Returns whether a sweep was started (tests).
 */
export function maybeStartScheduledSweep(db: Database.Database, deps: SweepDeps = {}): boolean {
  try {
    if (!hasTable(db, 'lead_source_runs') || !hasTable(db, 'ats_watchlist')) return false;
    const now = (deps.now ?? (() => new Date()))();
    settleInterruptedRuns(db, now);
    if (inFlight) return false;
    if (!getConfig<boolean>(db, 'ats_sweep_enabled')) return false;
    const pause = getPauseState();
    if (pause === 'halted' || pause === 'killswitch') return false;
    const last = db.prepare(`SELECT MAX(started_at) AS m FROM lead_source_runs WHERE kind = 'sweep'`).get() as {
      m: string | null;
    };
    if (!isScheduledSweepDue(getConfig<string>(db, 'ats_sweep_cron'), last.m, now)) return false;
    return startSweep(db, { trigger: 'schedule' }, deps).started;
  } catch (err) {
    log.warn('ats sweep: schedule check failed', { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ── the admin read ─────────────────────────────────────────────────────────

export interface LastSweepView {
  id: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean;
  trigger: SweepTrigger;
  boards_ok: number;
  boards_failed: number;
  new: number;
  refreshed: number;
  closed: number;
  reopened: number;
  rejected: Record<string, number>;
  failing_boards: FailingBoard[];
}

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** The newest FINISHED sweep (ok set), or null. */
export function readLastSweep(db: Database.Database): LastSweepView | null {
  if (!hasTable(db, 'lead_source_runs')) return null;
  const r = db
    .prepare(`SELECT * FROM lead_source_runs WHERE kind = 'sweep' AND ok IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    started_at: String(r.started_at),
    finished_at: (r.finished_at as string | null) ?? null,
    ok: r.ok === 1,
    trigger: r.trigger === 'manual' ? 'manual' : 'schedule',
    boards_ok: Number(r.boards_ok ?? 0),
    boards_failed: Number(r.boards_failed ?? 0),
    new: Number(r.new_count ?? 0),
    refreshed: Number(r.refreshed_count ?? 0),
    closed: Number(r.closed_count ?? 0),
    reopened: Number(r.reopened_count ?? 0),
    rejected: parseJson<Record<string, number>>(r.rejected_json, {}),
    failing_boards: parseJson<FailingBoard[]>(r.failing_boards_json, []),
  };
}

/** The newest SUCCESSFUL sweep's start time, or null (health + /architecture). */
export function readLastSuccessfulSweepAt(db: Database.Database): string | null {
  if (!hasTable(db, 'lead_source_runs')) return null;
  const r = db.prepare(`SELECT MAX(finished_at) AS m FROM lead_source_runs WHERE kind = 'sweep' AND ok = 1`).get() as {
    m: string | null;
  };
  return r.m;
}
