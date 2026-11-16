/**
 * src/modules/career-pilot/ats-watchlist.ts — the employer-board watchlist store
 * (STRATEGY.md §24.200 D7).
 *
 * `ats_watchlist` is the runtime truth for which Greenhouse / Lever / Ashby boards
 * the host reads: `fetch_source` resolves companies from its `active` rows, the
 * sweep fetches every `active` row, `discover_ats_board` inserts a verified board
 * (origin 'owner'), and "not interested → block company" pauses a company's boards.
 *
 * `groups/career-pilot/data/ats-targets.json` is read ONLY by
 * `ensureAtsWatchlistSeeded` — an idempotent insert-missing seed (origin 'seed').
 * It never overwrites a row, so an owner's pause or a retirement survives every
 * boot. The readers below run it once per DB handle before their first read, so
 * a process that never called it explicitly still sees the seeded boards.
 *
 * Host-side, synchronous, never throws from a reader on a bad seed file (it logs
 * and seeds nothing).
 */
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

import { normCompany } from './lead-promotion.js';
import { isAtsSource, type AtsSource, type SourcePriority } from './scrape-jobs/types.js';

export type WatchlistState = 'active' | 'paused' | 'absent';
export type WatchlistOrigin = 'seed' | 'owner' | 'search' | 'applied';

export const WATCHLIST_STATES: readonly WatchlistState[] = ['active', 'paused', 'absent'];
export const WATCHLIST_ORIGINS: readonly WatchlistOrigin[] = ['seed', 'owner', 'search', 'applied'];
const TIERS: readonly SourcePriority[] = ['A', 'B', 'C'];

export interface WatchlistRow {
  id: number;
  ats: AtsSource;
  token: string;
  company: string;
  tier: SourcePriority;
  origin: WatchlistOrigin;
  state: WatchlistState;
  notes: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_absent: number;
  leads_found: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The board-token grammar every ATS we support fits: a slug of letters, digits,
 * dot, dash and underscore. A token is only ever interpolated into the adapter's
 * own fixed base URL (and URL-encoded there), but a strict grammar keeps a
 * malformed or hostile value out of the table in the first place.
 */
const BOARD_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidBoardToken(token: unknown): token is string {
  return typeof token === 'string' && BOARD_TOKEN_RE.test(token);
}

export const DEFAULT_SEED_PATH = path.join(process.cwd(), 'groups', 'career-pilot', 'data', 'ats-targets.json');

const seededHandles = new WeakSet<Database.Database>();

export interface SeedResult {
  inserted: number;
  existing: number;
  invalid: number;
}

/**
 * Insert every valid seed-file board that is not already in the table, as
 * origin 'seed'. Never updates an existing row. Idempotent. Marks the handle as
 * seeded, so the readers' lazy seed does not run again for it.
 */
export function ensureAtsWatchlistSeeded(db: Database.Database, seedPath: string = DEFAULT_SEED_PATH): SeedResult {
  seededHandles.add(db);
  const result: SeedResult = { inserted: 0, existing: 0, invalid: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (err) {
    log.warn('ats watchlist seed: file unreadable — nothing seeded', {
      path: seedPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  if (!Array.isArray(parsed)) {
    log.warn('ats watchlist seed: file is not an array — nothing seeded', { path: seedPath });
    return result;
  }
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO ats_watchlist (ats, token, company, tier, origin, state, notes, created_at, updated_at)
     VALUES (@ats, @token, @company, @tier, 'seed', 'active', @notes, @now, @now)
     ON CONFLICT (ats, token) DO NOTHING`,
  );
  db.transaction(() => {
    for (const item of parsed as unknown[]) {
      const e = (item ?? {}) as Record<string, unknown>;
      const company = typeof e.company === 'string' ? e.company.trim() : '';
      const tier = TIERS.includes(e.priority as SourcePriority) ? (e.priority as SourcePriority) : null;
      if (!company || !isAtsSource(e.source) || !isValidBoardToken(e.token) || !tier) {
        result.invalid += 1;
        log.warn('ats watchlist seed: skipped invalid entry', { item });
        continue;
      }
      const changes = insert.run({
        ats: e.source,
        token: e.token,
        company,
        tier,
        notes: typeof e.notes === 'string' ? e.notes : null,
        now,
      }).changes;
      if (changes > 0) result.inserted += 1;
      else result.existing += 1;
    }
  })();
  if (result.inserted > 0) log.info('ats watchlist seeded', { ...result });
  return result;
}

/**
 * Run the insert-missing seed once per DB handle (a no-op after that). Readers
 * call it implicitly; a caller that queries `ats_watchlist` in raw SQL (the
 * stale rule's "is this board still swept?" test) calls it first, so a fresh
 * install never reads an unseeded table as "no board is watched".
 */
export function ensureSeededOnce(db: Database.Database): void {
  if (seededHandles.has(db)) return;
  try {
    ensureAtsWatchlistSeeded(db);
  } catch (err) {
    // A missing table (a bare test DB) or a write failure must not break a read.
    seededHandles.add(db);
    log.warn('ats watchlist lazy seed failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** Every watchlist row (optionally one state), stable order: tier, company. */
export function listWatchlist(db: Database.Database, opts: { state?: WatchlistState } = {}): WatchlistRow[] {
  ensureSeededOnce(db);
  if (opts.state) {
    return db
      .prepare('SELECT * FROM ats_watchlist WHERE state = ? ORDER BY tier, company, ats, token')
      .all(opts.state) as WatchlistRow[];
  }
  return db.prepare('SELECT * FROM ats_watchlist ORDER BY tier, company, ats, token').all() as WatchlistRow[];
}

/**
 * The `active` boards, optionally narrowed to one tier and/or one company (exact
 * name, case-insensitive) — what `fetch_source` and the sweep read.
 */
export function listActiveBoards(
  db: Database.Database,
  opts: { tier?: SourcePriority; company?: string } = {},
): WatchlistRow[] {
  return listWatchlist(db, { state: 'active' }).filter((r) => {
    if (!isAtsSource(r.ats)) return false;
    if (opts.tier && r.tier !== opts.tier) return false;
    if (opts.company && r.company.toLowerCase() !== opts.company.toLowerCase()) return false;
    return true;
  });
}

export function getBoard(db: Database.Database, ats: AtsSource, token: string): WatchlistRow | undefined {
  ensureSeededOnce(db);
  return db.prepare('SELECT * FROM ats_watchlist WHERE ats = ? AND token = ?').get(ats, token) as
    | WatchlistRow
    | undefined;
}

/** Every board (any state) whose company normalizes to the same name. */
export function findBoardsByCompany(db: Database.Database, company: string): WatchlistRow[] {
  const want = normCompany(company);
  if (!want) return [];
  return listWatchlist(db).filter((r) => normCompany(r.company) === want);
}

export interface UpsertBoardInput {
  ats: string;
  token: string;
  company: string;
  tier?: SourcePriority;
  origin: WatchlistOrigin;
  notes?: string | null;
  /** When the board already exists and was RETIRED (`absent`): set it back to
   *  `active` — it answered again. A `paused` board is never reactivated here:
   *  a pause is the owner's decision ("block company"), and only the owner
   *  undoes it. */
  reactivate?: boolean;
}

export type UpsertBoardResult =
  | { ok: true; inserted: boolean; row: WatchlistRow }
  | { ok: false; error: 'bad_ats' | 'bad_token' | 'bad_company' | 'bad_tier' | 'bad_origin' };

/** Add a board, or return the existing one for the same (ats, token). Validates
 *  every field; never throws on bad input. */
export function upsertBoard(db: Database.Database, input: UpsertBoardInput): UpsertBoardResult {
  if (!isAtsSource(input.ats)) return { ok: false, error: 'bad_ats' };
  if (!isValidBoardToken(input.token)) return { ok: false, error: 'bad_token' };
  const company = typeof input.company === 'string' ? input.company.trim() : '';
  if (!company || company.length > 200) return { ok: false, error: 'bad_company' };
  const tier = input.tier ?? 'B';
  if (!TIERS.includes(tier)) return { ok: false, error: 'bad_tier' };
  if (!WATCHLIST_ORIGINS.includes(input.origin)) return { ok: false, error: 'bad_origin' };

  ensureSeededOnce(db);
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO ats_watchlist (ats, token, company, tier, origin, state, notes, created_at, updated_at)
       VALUES (@ats, @token, @company, @tier, @origin, 'active', @notes, @now, @now)
       ON CONFLICT (ats, token) DO NOTHING`,
    )
    .run({ ats: input.ats, token: input.token, company, tier, origin: input.origin, notes: input.notes ?? null, now });
  const inserted = res.changes > 0;
  if (!inserted && input.reactivate) {
    db.prepare(
      `UPDATE ats_watchlist SET state = 'active', consecutive_failures = 0, consecutive_absent = 0, updated_at = ?
        WHERE ats = ? AND token = ? AND state = 'absent'`,
    ).run(now, input.ats, input.token);
  }
  const row = db
    .prepare('SELECT * FROM ats_watchlist WHERE ats = ? AND token = ?')
    .get(input.ats, input.token) as WatchlistRow;
  if (inserted) log.info('ats watchlist: board added', { ats: input.ats, token: input.token, origin: input.origin });
  return { ok: true, inserted, row };
}

/** Set one board's state. Returns false for an unknown id or state. */
export function setBoardState(db: Database.Database, id: number, state: WatchlistState): boolean {
  if (!WATCHLIST_STATES.includes(state)) return false;
  const res = db
    .prepare(
      `UPDATE ats_watchlist
          SET state = @state, updated_at = @now,
              consecutive_failures = CASE WHEN @state = 'active' THEN 0 ELSE consecutive_failures END,
              consecutive_absent = CASE WHEN @state = 'active' THEN 0 ELSE consecutive_absent END
        WHERE id = @id`,
    )
    .run({ id, state, now: new Date().toISOString() });
  return res.changes > 0;
}

/**
 * "Not interested → block company" (§24.201 D4): pause every `active` board of
 * that company. `matched` counts boards of the company in any state — the
 * caller's `company_blocked` is `matched > 0`.
 */
export function pauseBoardsForCompany(db: Database.Database, company: string): { matched: number; paused: number } {
  const boards = findBoardsByCompany(db, company);
  let paused = 0;
  for (const b of boards) {
    if (b.state === 'active' && setBoardState(db, b.id, 'paused')) paused += 1;
  }
  if (paused > 0) log.info('ats watchlist: company boards paused', { company, paused });
  return { matched: boards.length, paused };
}

export interface BoardFetchOutcome {
  ok: boolean;
  absent: boolean;
  error?: string | null;
  /** Leads this fetch added to the pool (sweep), for `leads_found` / `last_hit_at`. */
  newLeads?: number;
}

/**
 * Record one fetch of a board. `ok` resets both streaks and stamps `last_ok_at`.
 * Any failure extends `consecutive_failures` (what health reports). Only an
 * `absent` answer (the ATS says the board does not exist — 404/410) extends
 * `consecutive_absent`, and only that streak reaching `ats_watchlist_retire_after`
 * sets the board `absent` (no longer swept). A transient failure (429, 5xx,
 * timeout, DNS) never retires a board — an egress or vendor outage must not
 * silently remove the primary lead source — and it neither confirms nor refutes
 * absence, so it leaves the absent streak where it was.
 */
export function recordBoardFetch(
  db: Database.Database,
  id: number,
  outcome: BoardFetchOutcome,
  now: Date = new Date(),
): { retired: boolean; consecutive_failures: number; consecutive_absent: number } {
  const nowIso = now.toISOString();
  if (outcome.ok) {
    const n = Math.max(0, Math.floor(outcome.newLeads ?? 0));
    db.prepare(
      `UPDATE ats_watchlist
          SET last_ok_at = @now, last_error = NULL, consecutive_failures = 0, consecutive_absent = 0,
              leads_found = leads_found + @n,
              last_hit_at = CASE WHEN @n > 0 THEN @now ELSE last_hit_at END,
              updated_at = @now
        WHERE id = @id`,
    ).run({ id, n, now: nowIso });
    return { retired: false, consecutive_failures: 0, consecutive_absent: 0 };
  }
  const error = outcome.absent
    ? `board absent${outcome.error ? ` (${outcome.error})` : ''}`
    : (outcome.error ?? 'failed');
  db.prepare(
    `UPDATE ats_watchlist
        SET last_error = @error, consecutive_failures = consecutive_failures + 1,
            consecutive_absent = consecutive_absent + @absent, updated_at = @now
      WHERE id = @id`,
  ).run({ id, error: error.slice(0, 500), absent: outcome.absent ? 1 : 0, now: nowIso });
  const row = db
    .prepare('SELECT consecutive_failures, consecutive_absent, state FROM ats_watchlist WHERE id = ?')
    .get(id) as { consecutive_failures: number; consecutive_absent: number; state: string } | undefined;
  if (!row) return { retired: false, consecutive_failures: 0, consecutive_absent: 0 };
  const retireAfter = getConfig<number>(db, 'ats_watchlist_retire_after');
  if (outcome.absent && row.state === 'active' && retireAfter > 0 && row.consecutive_absent >= retireAfter) {
    // Not setBoardState: that would reset the streaks the owner reads to see why.
    db.prepare(`UPDATE ats_watchlist SET state = 'absent', updated_at = ? WHERE id = ?`).run(nowIso, id);
    log.warn('ats watchlist: board retired after repeated "board absent" answers', {
      id,
      consecutive_absent: row.consecutive_absent,
    });
    return {
      retired: true,
      consecutive_failures: row.consecutive_failures,
      consecutive_absent: row.consecutive_absent,
    };
  }
  return { retired: false, consecutive_failures: row.consecutive_failures, consecutive_absent: row.consecutive_absent };
}

// ── posting identity from a URL ─────────────────────────────────────────────

/** The board posting a URL points at: which ATS, which board, which job. */
export interface AtsJobRef {
  ats: AtsSource;
  /** Board token, lower-cased (board slugs are case-insensitive on every ATS). */
  token: string;
  job_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a posting URL on one of the fixed per-ATS hosts into its identity, or
 * null. Pure string parsing — the URL is never fetched. Used to recognise that
 * a search hit already in the pool IS a board posting the sweep is listing
 * (the same job under source 'google_jobs'), so the sweep does not insert it
 * twice and the owner's triage of the search copy carries over.
 *
 *   Greenhouse: {job-boards,boards}[.eu].greenhouse.io/<token>/jobs/<id>
 *               and the embed form …/embed/job_app?for=<token>&token=<id>
 *   Lever:      jobs[.eu].lever.co/<token>/<uuid>[/apply]
 *   Ashby:      jobs.ashbyhq.com/<token>/<uuid>[/application]
 */
export function parseAtsJobUrl(url: unknown): AtsJobRef | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const ref = (ats: AtsSource, token: string | undefined | null, job: string | undefined | null) =>
    token && job && isValidBoardToken(token) ? { ats, token: token.toLowerCase(), job_id: job } : null;

  if (/^(job-boards|boards)\.(eu\.)?greenhouse\.io$/.test(host)) {
    if (seg[0] === 'embed' && seg[1] === 'job_app') {
      const id = u.searchParams.get('token');
      return id && /^\d+$/.test(id) ? ref('greenhouse', u.searchParams.get('for'), id) : null;
    }
    if (seg.length >= 3 && seg[1] === 'jobs' && /^\d+$/.test(seg[2])) return ref('greenhouse', seg[0], seg[2]);
    return null;
  }
  if (/^jobs\.(eu\.)?lever\.co$/.test(host)) {
    return seg.length >= 2 && UUID_RE.test(seg[1]) ? ref('lever', seg[0], seg[1].toLowerCase()) : null;
  }
  if (host === 'jobs.ashbyhq.com') {
    return seg.length >= 2 && UUID_RE.test(seg[1]) ? ref('ashby', seg[0], seg[1].toLowerCase()) : null;
  }
  return null;
}

/** The map key for one board posting: `ats:token:job_id`, token and uuid lower-cased. */
export function atsJobKey(ats: AtsSource, token: string, jobId: string): string {
  return `${ats}:${token.toLowerCase()}:${UUID_RE.test(jobId) ? jobId.toLowerCase() : jobId}`;
}
