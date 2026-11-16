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

import { hasTable } from '../../db/connection.js';
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
     ON CONFLICT DO NOTHING`,
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
  return db.prepare('SELECT * FROM ats_watchlist WHERE ats = ? AND lower(token) = lower(?)').get(ats, token) as
    | WatchlistRow
    | undefined;
}

// ── owner removals ──────────────────────────────────────────────────────────

/**
 * Remember that the owner removed this board (the Watchlist tab's *remove*), so
 * the automatic growth paths and the agent's discover do not add it back. Only
 * the owner re-adding it by URL clears the record (`clearBoardRemoved`). A no-op
 * on a DB without the table.
 */
export function markBoardRemoved(db: Database.Database, ats: string, token: string, now: Date = new Date()): void {
  if (!hasTable(db, 'ats_watchlist_removed')) return;
  db.prepare(
    `INSERT INTO ats_watchlist_removed (ats, token, removed_at) VALUES (?, ?, ?)
     ON CONFLICT (ats, token) DO UPDATE SET removed_at = excluded.removed_at`,
  ).run(ats, token.toLowerCase(), now.toISOString());
}

export function isBoardRemoved(db: Database.Database, ats: string, token: string): boolean {
  if (!hasTable(db, 'ats_watchlist_removed')) return false;
  return (
    db.prepare('SELECT 1 FROM ats_watchlist_removed WHERE ats = ? AND token = ?').get(ats, token.toLowerCase()) !==
    undefined
  );
}

export function clearBoardRemoved(db: Database.Database, ats: string, token: string): void {
  if (!hasTable(db, 'ats_watchlist_removed')) return;
  db.prepare('DELETE FROM ats_watchlist_removed WHERE ats = ? AND token = ?').run(ats, token.toLowerCase());
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

/** Add a board, or return the existing one for the same (ats, token) — the token
 *  matched case-insensitively, as every ATS treats it (the table enforces that
 *  with a UNIQUE index on `(ats, lower(token))`). Validates every field; never
 *  throws on bad input. */
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
       ON CONFLICT DO NOTHING`,
    )
    .run({ ats: input.ats, token: input.token, company, tier, origin: input.origin, notes: input.notes ?? null, now });
  const inserted = res.changes > 0;
  if (!inserted && input.reactivate) {
    db.prepare(
      `UPDATE ats_watchlist SET state = 'active', consecutive_failures = 0, consecutive_absent = 0, updated_at = ?
        WHERE ats = ? AND lower(token) = lower(?) AND state = 'absent'`,
    ).run(now, input.ats, input.token);
  }
  const row = db
    .prepare('SELECT * FROM ats_watchlist WHERE ats = ? AND lower(token) = lower(?) ORDER BY id LIMIT 1')
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

// ── board / posting identity from a URL ─────────────────────────────────────

/** The board (and, for a posting link, the job) a URL points at. */
export interface AtsUrlRef {
  ats: AtsSource;
  /**
   * Board token as it appears in the URL, lower-cased (board slugs are
   * case-insensitive on every ATS). NOT validated here — a caller checks
   * `isValidBoardToken` so it can tell "not a board link" from "a board link
   * with a malformed name".
   */
  token: string;
  /** Present only for a posting link. */
  job_id?: string;
  /**
   * 'eu' when the link is on an EU-region host (`*.eu.greenhouse.io`,
   * `jobs.eu.lever.co`). Such a board is served by the vendor's EU API host,
   * which no adapter calls — so it is recognised (a posting's identity still
   * holds) but never added, grown or read: see `EU_BOARD_UNSUPPORTED_MESSAGE`.
   */
  region?: 'eu';
}

/** Why an EU-region board link is refused by every add and growth path. */
export const EU_BOARD_UNSUPPORTED_MESSAGE =
  'That board is hosted in the EU region, which this system cannot read yet. Only US-hosted Greenhouse and Lever boards, and Ashby boards, can be added.';

/** The board posting a URL points at: which ATS, which board, which job. */
export interface AtsJobRef {
  ats: AtsSource;
  /** Board token, lower-cased (board slugs are case-insensitive on every ATS). */
  token: string;
  job_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GREENHOUSE_HOST_RE = /^(job-boards|boards)\.(eu\.)?greenhouse\.io$/;
const LEVER_HOST_RE = /^jobs\.(eu\.)?lever\.co$/;
const ASHBY_HOST = 'jobs.ashbyhq.com';
/** Longest URL the parser looks at (a pasted link; nothing real is longer). */
export const ATS_URL_MAX_CHARS = 2000;

/**
 * Parse a board or posting URL on one of the fixed per-ATS hosts into
 * `{ats, token, job_id?}`, or null when the host / path is not one of the forms
 * below. Pure string parsing — the URL is NEVER fetched; a caller that needs the
 * board reads it through the adapter's own fixed API host. No credentials, no
 * explicit port, http(s) only.
 *
 *   Greenhouse (current `job-boards.` and legacy `boards.` hosts, both `.eu`):
 *               <host>/<token>                     board
 *               <host>/<token>/jobs/<id>           posting
 *               <host>/embed/job_board?for=<token> board (embed)
 *               <host>/embed/job_app?for=<token>[&token=<id>]
 *   Lever:      jobs[.eu].lever.co/<token>[/<uuid>[/apply]]
 *   Ashby:      jobs.ashbyhq.com/<token>[/<uuid>[/application]]
 */
export function parseAtsUrl(url: unknown): AtsUrlRef | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > ATS_URL_MAX_CHARS) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const eu = /\.eu\.(greenhouse\.io|lever\.co)$/.test(host);
  const out = (ats: AtsSource, token: string | null | undefined, jobId?: string): AtsUrlRef | null => {
    if (!token) return null;
    const ref: AtsUrlRef = { ats, token: token.toLowerCase() };
    if (jobId) ref.job_id = jobId;
    if (eu) ref.region = 'eu';
    return ref;
  };

  if (GREENHOUSE_HOST_RE.test(host)) {
    if (seg[0] === 'embed') {
      if (seg.length !== 2) return null;
      const forToken = u.searchParams.get('for');
      if (seg[1] === 'job_board') return out('greenhouse', forToken);
      if (seg[1] === 'job_app') {
        const id = u.searchParams.get('token');
        if (id == null) return out('greenhouse', forToken);
        return /^\d+$/.test(id) ? out('greenhouse', forToken, id) : null;
      }
      return null;
    }
    if (seg.length === 1) return out('greenhouse', seg[0]);
    if (seg.length === 2 && seg[1] === 'jobs') return out('greenhouse', seg[0]);
    if (seg.length === 3 && seg[1] === 'jobs' && /^\d+$/.test(seg[2])) return out('greenhouse', seg[0], seg[2]);
    return null;
  }
  if (LEVER_HOST_RE.test(host)) {
    if (seg.length === 1) return out('lever', seg[0]);
    if ((seg.length === 2 || (seg.length === 3 && seg[2] === 'apply')) && UUID_RE.test(seg[1])) {
      return out('lever', seg[0], seg[1].toLowerCase());
    }
    return null;
  }
  if (host === ASHBY_HOST) {
    if (seg.length === 1) return out('ashby', seg[0]);
    if ((seg.length === 2 || (seg.length === 3 && seg[2] === 'application')) && UUID_RE.test(seg[1])) {
      return out('ashby', seg[0], seg[1].toLowerCase());
    }
    return null;
  }
  return null;
}

/**
 * A POSTING URL's identity, or null (a board link, an unknown host, or a
 * malformed token). Used to recognise that a search hit already in the pool IS
 * a board posting the sweep is listing (the same job under source
 * 'google_jobs'), so the sweep does not insert it twice and the owner's triage
 * of the search copy carries over. A thin wrapper over `parseAtsUrl`.
 */
export function parseAtsJobUrl(url: unknown): AtsJobRef | null {
  const ref = parseAtsUrl(url);
  if (!ref || !ref.job_id || !isValidBoardToken(ref.token)) return null;
  return { ats: ref.ats, token: ref.token, job_id: ref.job_id };
}

/** A board's public page, built from the fixed per-ATS host (never stored, never fetched). */
export function boardPublicUrl(ats: AtsSource, token: string): string {
  const t = encodeURIComponent(token);
  if (ats === 'greenhouse') return `https://job-boards.greenhouse.io/${t}`;
  if (ats === 'lever') return `https://jobs.lever.co/${t}`;
  return `https://${ASHBY_HOST}/${t}`;
}

/** `acme-robotics` → `Acme Robotics` — a company name when nothing better is known
 *  (no board adapter exposes the employer's name). */
export function titleCaseToken(token: string): string {
  return token
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ── growth (§24.200 D7) ─────────────────────────────────────────────────────

/** The board row for (ats, token), matched case-insensitively on the token. */
export function findBoard(db: Database.Database, ats: AtsSource, token: string): WatchlistRow | undefined {
  ensureSeededOnce(db);
  return db
    .prepare('SELECT * FROM ats_watchlist WHERE ats = ? AND lower(token) = lower(?) ORDER BY id LIMIT 1')
    .get(ats, token) as WatchlistRow | undefined;
}

/** Rows the `ats_watchlist_max_boards` cap compares against: every board not retired. */
export function countCountedBoards(db: Database.Database): number {
  ensureSeededOnce(db);
  return (db.prepare(`SELECT COUNT(*) AS n FROM ats_watchlist WHERE state != 'absent'`).get() as { n: number }).n;
}

export interface WatchlistCaps {
  max_boards: number;
  counted: number;
  max_auto_adds_per_run: number;
}

export function readWatchlistCaps(db: Database.Database): WatchlistCaps {
  return {
    max_boards: Math.max(0, Math.floor(getConfig<number>(db, 'ats_watchlist_max_boards'))),
    counted: countCountedBoards(db),
    max_auto_adds_per_run: Math.max(0, Math.floor(getConfig<number>(db, 'ats_watchlist_max_auto_adds_per_run'))),
  };
}

/** One board a search hit pointed at (the payload fields growth reads). */
interface SearchHitLike {
  source?: string;
  apply_link_kind?: string | null;
  apply_url?: string | null;
  source_url?: string | null;
  company?: string | null;
}

export interface SearchGrowthResult {
  /** Boards inserted as origin 'search'. */
  added: Array<{ ats: AtsSource; token: string; company: string }>;
  /** New boards seen but not added because a cap was reached. */
  rejected_cap: number;
}

/**
 * Growth path 1: a search hit whose link is already a direct ATS link yields its
 * board. Each distinct board not yet on the watchlist (in ANY state — a paused
 * board is the owner's block, a retired one answered "gone") is inserted as
 * origin 'search', until `ats_watchlist_max_auto_adds_per_run` boards were added
 * by this call or the watchlist reaches `ats_watchlist_max_boards`; every further
 * new board is counted in `rejected_cap`. No fetch: the link came from a live
 * listing, and a token that turns out wrong is retired by the sweep's "board
 * gone" counter. Never throws (a write failure adds nothing).
 */
export function growWatchlistFromSearchHits(db: Database.Database, hits: readonly SearchHitLike[]): SearchGrowthResult {
  const result: SearchGrowthResult = { added: [], rejected_cap: 0 };
  try {
    const caps = readWatchlistCaps(db);
    let counted = caps.counted;
    const seen = new Set<string>();
    for (const hit of hits) {
      if (!hit || (hit.apply_link_kind ?? null) !== 'ats') continue;
      const ref = parseAtsUrl(hit.apply_url) ?? parseAtsUrl(hit.source_url);
      // An EU-region board is served by an API host no adapter calls: adding it
      // would only fail every sweep until it retired.
      if (!ref || ref.region === 'eu' || !isValidBoardToken(ref.token)) continue;
      const key = `${ref.ats}:${ref.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (findBoard(db, ref.ats, ref.token)) continue;
      // The owner removed it: a remove must stick against automatic growth.
      if (isBoardRemoved(db, ref.ats, ref.token)) continue;
      if (result.added.length >= caps.max_auto_adds_per_run || counted >= caps.max_boards) {
        result.rejected_cap += 1;
        continue;
      }
      const given = typeof hit.company === 'string' ? hit.company.trim() : '';
      const company = given && given.length <= 200 ? given : titleCaseToken(ref.token) || ref.token;
      const up = upsertBoard(db, { ats: ref.ats, token: ref.token, company, origin: 'search' });
      if (up.ok && up.inserted) {
        result.added.push({ ats: ref.ats, token: ref.token, company: up.row.company });
        counted += 1;
      }
    }
  } catch (err) {
    log.warn('ats watchlist: growth from search hits failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

const TIER_UP: Record<SourcePriority, SourcePriority> = { A: 'A', B: 'A', C: 'B' };

export type AppliedBoardOutcome =
  | { action: 'added'; ats: AtsSource; token: string; tier: SourcePriority }
  | { action: 'tier_raised'; ats: AtsSource; token: string; tier: SourcePriority }
  | {
      action: 'unchanged';
      ats: AtsSource;
      token: string;
      reason: 'already_top_tier' | 'paused' | 'absent' | 'cap_reached' | 'removed_by_owner';
    };

/**
 * Growth path 3 (owner signal): the owner applied from a lead, so that lead's
 * board matters more. The board is the lead's own (a board-sourced lead), or the
 * one its direct ATS link points at (a search hit with an `ats` link).
 *   - not on the watchlist → inserted as origin 'applied' (tier B), within
 *     `ats_watchlist_max_boards`;
 *   - listed and active → its tier is raised one step (C→B, B→A) — tier is
 *     `fetch_source`'s priority filter;
 *   - listed but paused (an owner block) or retired → left alone.
 * Returns null when the lead has no board. Never throws.
 */
export function promoteBoardForAppliedLead(db: Database.Database, leadId: string): AppliedBoardOutcome | null {
  try {
    if (!hasTable(db, 'ats_watchlist')) return null;
    const lead = db
      .prepare(
        `SELECT source, source_board_token, apply_link_kind, apply_url, source_url, company
           FROM job_leads WHERE id = ?`,
      )
      .get(leadId) as
      | {
          source: string;
          source_board_token: string | null;
          apply_link_kind: string | null;
          apply_url: string | null;
          source_url: string | null;
          company: string | null;
        }
      | undefined;
    if (!lead) return null;
    let ats: AtsSource | null = null;
    let token: string | null = null;
    if (isAtsSource(lead.source) && isValidBoardToken(lead.source_board_token)) {
      ats = lead.source;
      token = lead.source_board_token.toLowerCase();
    } else if (lead.apply_link_kind === 'ats') {
      const ref = parseAtsUrl(lead.apply_url) ?? parseAtsUrl(lead.source_url);
      // An EU-region board is not one any adapter can read — no board to promote.
      if (ref && ref.region !== 'eu' && isValidBoardToken(ref.token)) {
        ats = ref.ats;
        token = ref.token;
      }
    }
    if (!ats || !token) return null;

    const existing = findBoard(db, ats, token);
    if (existing) {
      if (existing.state !== 'active') return { action: 'unchanged', ats, token, reason: existing.state };
      const next = TIER_UP[existing.tier] ?? existing.tier;
      if (next === existing.tier) return { action: 'unchanged', ats, token, reason: 'already_top_tier' };
      db.prepare('UPDATE ats_watchlist SET tier = ?, updated_at = ? WHERE id = ?').run(
        next,
        new Date().toISOString(),
        existing.id,
      );
      log.info('ats watchlist: board tier raised after an application', { ats, token, tier: next });
      return { action: 'tier_raised', ats, token, tier: next };
    }
    if (isBoardRemoved(db, ats, token)) return { action: 'unchanged', ats, token, reason: 'removed_by_owner' };
    const caps = readWatchlistCaps(db);
    if (caps.counted >= caps.max_boards) return { action: 'unchanged', ats, token, reason: 'cap_reached' };
    const given = (lead.company ?? '').trim();
    const company = given && given.length <= 200 ? given : titleCaseToken(token) || token;
    const up = upsertBoard(db, { ats, token, company, origin: 'applied' });
    if (!up.ok) return null;
    return { action: 'added', ats, token, tier: up.row.tier };
  } catch (err) {
    log.warn('ats watchlist: board promotion after an application failed', {
      leadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The map key for one board posting: `ats:token:job_id`, token and uuid lower-cased. */
export function atsJobKey(ats: AtsSource, token: string, jobId: string): string {
  return `${ats}:${token.toLowerCase()}:${UUID_RE.test(jobId) ? jobId.toLowerCase() : jobId}`;
}
