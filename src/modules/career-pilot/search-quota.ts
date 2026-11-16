/**
 * src/modules/career-pilot/search-quota.ts — the search supplement's spend gate
 * and its run summary (STRATEGY.md §24.201 D8, §24.202 D6).
 *
 * The container's `search_jobs` tool calls `career_pilot.reserve_search_quota`
 * BEFORE each result page it fetches. The host counts pages per UTC day in
 * `search_quota_usage` and refuses past `search_daily_page_cap` or past
 * `search_monthly_quota` since the period's anchor day
 * (`search_quota_period_anchor_day`); the tool then answers `unavailable`.
 * A dedicated counter rather than request_telemetry: that table is pruned,
 * written best-effort from the container and can be switched off, and a spend
 * gate must not depend on an observability table.
 *
 * `recordSearchRun` writes one `lead_source_runs` row (kind 'search') per stash,
 * carrying what the insert guard refused, by reason and by originating site
 * (`raw_payload.via`), for the Leads tab's "last search" line.
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

/** Pages one reservation may ask for (the tool reserves page by page). */
const MAX_PAGES_PER_RESERVATION = 10;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The first day (UTC, `YYYY-MM-DD`) of the billing period containing `now`: the
 * most recent date on or before today whose day-of-month is `anchorDay`
 * (clamped to 1..28 so every month has it).
 */
export function quotaPeriodStart(now: Date, anchorDay: number): string {
  const a = Math.min(28, Math.max(1, Math.floor(Number.isFinite(anchorDay) ? anchorDay : 1)));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = now.getUTCDate() >= a ? new Date(Date.UTC(y, m, a)) : new Date(Date.UTC(y, m - 1, a));
  return utcDay(start);
}

export interface SearchQuotaView {
  used_period: number;
  monthly_quota: number;
  used_today: number;
  daily_cap: number;
  period_start: string;
}

export function readSearchQuota(db: Database.Database, now: Date = new Date()): SearchQuotaView {
  const daily_cap = getConfig<number>(db, 'search_daily_page_cap');
  const monthly_quota = getConfig<number>(db, 'search_monthly_quota');
  const period_start = quotaPeriodStart(now, getConfig<number>(db, 'search_quota_period_anchor_day'));
  if (!hasTable(db, 'search_quota_usage')) {
    return { used_period: 0, monthly_quota, used_today: 0, daily_cap, period_start };
  }
  const today = utcDay(now);
  const usedToday = (
    db.prepare('SELECT COALESCE(SUM(pages), 0) AS n FROM search_quota_usage WHERE day = ?').get(today) as {
      n: number;
    }
  ).n;
  const usedPeriod = (
    db
      .prepare('SELECT COALESCE(SUM(pages), 0) AS n FROM search_quota_usage WHERE day >= ? AND day <= ?')
      .get(period_start, today) as { n: number }
  ).n;
  return { used_period: usedPeriod, monthly_quota, used_today: usedToday, daily_cap, period_start };
}

export type QuotaRefusal = 'daily_cap' | 'monthly_quota';

export type ReserveResult =
  | ({ granted: true } & SearchQuotaView)
  | ({ granted: false; reason: QuotaRefusal; message: string } & SearchQuotaView);

/**
 * Reserve `pages` result pages, atomically: refused (nothing recorded) when the
 * day's cap or the period's quota would be exceeded; otherwise counted.
 */
export function reserveSearchPages(db: Database.Database, pages: number, now: Date = new Date()): ReserveResult {
  return db.transaction((): ReserveResult => {
    const q = readSearchQuota(db, now);
    if (q.used_today + pages > q.daily_cap) {
      return {
        granted: false,
        reason: 'daily_cap',
        message: `daily search budget spent (${q.used_today}/${q.daily_cap} pages today); resets at 00:00 UTC`,
        ...q,
      };
    }
    if (q.used_period + pages > q.monthly_quota) {
      return {
        granted: false,
        reason: 'monthly_quota',
        message: `search quota for this period spent (${q.used_period}/${q.monthly_quota} pages since ${q.period_start})`,
        ...q,
      };
    }
    db.prepare(
      `INSERT INTO search_quota_usage (day, pages, updated_at) VALUES (@day, @pages, @now)
       ON CONFLICT (day) DO UPDATE SET pages = pages + excluded.pages, updated_at = excluded.updated_at`,
    ).run({ day: utcDay(now), pages, now: now.toISOString() });
    return { granted: true, ...q, used_today: q.used_today + pages, used_period: q.used_period + pages };
  })();
}

// ── the search-run summary ─────────────────────────────────────────────────

export interface LastSearchView {
  at: string;
  rejected: Record<string, number>;
  rejected_by_site: Record<string, number>;
}

/** One `lead_source_runs` row (kind 'search') for one stash. Best-effort. */
export function recordSearchRun(
  db: Database.Database,
  summary: { rejected: Record<string, number>; rejected_by_site: Record<string, number>; stashed: number },
  now: Date = new Date(),
): void {
  try {
    if (!hasTable(db, 'lead_source_runs')) return;
    const at = now.toISOString();
    db.prepare(
      `INSERT INTO lead_source_runs (id, kind, trigger, started_at, finished_at, ok, new_count, rejected_json, rejected_by_site_json)
       VALUES (@id, 'search', 'agent', @at, @at, 1, @stashed, @rejected, @by_site)`,
    ).run({
      id: `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at,
      stashed: summary.stashed,
      rejected: JSON.stringify(summary.rejected),
      by_site: JSON.stringify(summary.rejected_by_site),
    });
  } catch (err) {
    log.warn('search run summary not recorded', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** The site a search payload reached us through (`raw_payload.via`), or null. */
export function searchPayloadSite(payload: unknown): string | null {
  const raw = (payload as { raw_payload?: unknown } | null)?.raw_payload;
  if (!raw || typeof raw !== 'object') return null;
  const via = (raw as { via?: unknown }).via;
  if (typeof via !== 'string') return null;
  const site = via
    .replace(/^via\s+/i, '')
    .trim()
    .slice(0, 80);
  return site || null;
}

export function readLastSearch(db: Database.Database): LastSearchView | null {
  if (!hasTable(db, 'lead_source_runs')) return null;
  const r = db
    .prepare(
      `SELECT started_at, rejected_json, rejected_by_site_json FROM lead_source_runs
        WHERE kind = 'search' ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as { started_at: string; rejected_json: string; rejected_by_site_json: string } | undefined;
  if (!r) return null;
  const parse = (s: string): Record<string, number> => {
    try {
      return JSON.parse(s) as Record<string, number>;
    } catch {
      return {};
    }
  };
  return { at: r.started_at, rejected: parse(r.rejected_json), rejected_by_site: parse(r.rejected_by_site_json) };
}

// ── the host action ────────────────────────────────────────────────────────

function writeResponse(
  inDb: Database.Database,
  requestId: string,
  frame: { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } },
): void {
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

/**
 * `career_pilot.reserve_search_quota { pages }` → `{ granted, reason?, message?,
 * used_today, daily_cap, used_period, monthly_quota, period_start }`. A refusal
 * is a normal answer (ok:true, granted:false); only bad input or a DB failure is
 * an error frame. Never throws.
 */
export async function handleReserveSearchQuota(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = (content.requestId as string) || 'unknown';
  const p = (content.payload as Record<string, unknown>) ?? {};
  const pages = p.pages === undefined || p.pages === null ? 1 : p.pages;
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES_PER_RESERVATION) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: `pages must be an integer 1..${MAX_PAGES_PER_RESERVATION}` },
    });
    return;
  }
  try {
    const result = reserveSearchPages(getDb(), pages);
    if (!result.granted) log.info('search quota: reservation refused', { reason: result.reason, pages });
    writeResponse(inDb, requestId, { ok: true, data: { ...result } });
  } catch (err) {
    log.error('handleReserveSearchQuota failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}
