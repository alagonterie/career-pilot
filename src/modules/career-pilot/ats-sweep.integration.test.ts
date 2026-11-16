/**
 * The direct employer-board sweep (STRATEGY.md §24.201 D5, D6c) end to end over
 * a real migrated DB, with the board adapter injected (fixtures — no network):
 *   - a sweep inserts only direct (`ats`) rows and writes a `lead_source_runs` row;
 *   - title / location / age filters and the per-run cap reject by reason; an
 *     uncompilable stored pattern is skipped and reported, never a crash;
 *   - a tombstoned board posting is not re-inserted by the next sweep;
 *   - two `ok` sweeps 15 days apart keep a board lead open (presence refreshed);
 *   - close-on-absence closes on an `ok` fetch, never on a 429, an absent board,
 *     a suspect empty response or for a promoted lead, and reopens on return;
 *   - an absent board feeds the retire counter; a transient failure never does;
 *   - a run in which every board failed is recorded as failed (ok=0);
 *   - a posting already in the pool as a search hit (same ATS job by URL) is
 *     refreshed, not inserted a second time;
 *   - single-flight, and nothing starts under halted / killswitch;
 *   - the schedule fires once when due, collapses missed occurrences into one
 *     run (a resume after standby is not a burst), and never waits on the run.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { setPauseState } from '../portal/system-modes.js';

import {
  _awaitInFlightSweepForTesting,
  _resetSweepSchedulerForTesting,
  isScheduledSweepDue,
  isSweepRunning,
  maybeStartScheduledSweep,
  readLastSuccessfulSweepAt,
  readLastSweep,
  startSweep,
  sweepWatchlist,
  type SweepDeps,
} from './ats-sweep.js';
import { ensureAtsWatchlistSeeded, getBoard, upsertBoard } from './ats-watchlist.js';
import { buildCloseStaleEligibilityClause, upsertJobLead } from './job-lead-actions.js';
import { writeTombstone } from './lead-guard.js';
import type { AtsSource, JobLeadPayload, SourceListResult } from './scrape-jobs/types.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-ats-sweep-${process.pid}`);
const emptySeed = path.join(tmpDir, 'empty-seed.json');

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(emptySeed, '[]');
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // A sweep left running by a failed test must not leak into the next one.
  await _awaitInFlightSweepForTesting();
  closeDb();
  runMigrations(initTestDb());
  ensureAtsWatchlistSeeded(getDb(), emptySeed);
  _resetSweepSchedulerForTesting();
});

function setPref(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value), new Date().toISOString());
}

function addBoard(token: string, company: string, ats: AtsSource = 'greenhouse'): number {
  const r = upsertBoard(getDb(), { ats, token, company, origin: 'owner' });
  if (!r.ok) throw new Error(r.error);
  return r.row.id;
}

function posting(token: string, id: string, over: Partial<JobLeadPayload> = {}): JobLeadPayload {
  return {
    source: 'greenhouse',
    source_board_token: token,
    source_job_id: id,
    source_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    apply_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    title: `Senior Software Engineer ${id}`,
    company: '',
    location_raw: 'Remote - US',
    description_text: `Distinct description for posting ${id} with enough words to fingerprint it apart.`,
    source_posted_at: new Date().toISOString(),
    ...over,
  };
}

const ok = (postings: JobLeadPayload[]): SourceListResult => ({ ok: true, absent: false, postings, status: 200 });
const http429: SourceListResult = { ok: false, absent: false, postings: [], status: 429, error: 'HTTP 429' };
const absentBoard: SourceListResult = { ok: false, absent: true, postings: [], status: 404, error: 'HTTP 404' };

/** Deps whose listBoard answers from a per-token table. */
function boards(table: Record<string, SourceListResult>, now?: Date): SweepDeps {
  return {
    listBoard: async (_ats, token) => table[token] ?? ok([]),
    ...(now ? { now: () => now } : {}),
  };
}

async function sweep(deps: SweepDeps, trigger: 'schedule' | 'manual' = 'manual') {
  const out = await sweepWatchlist(getDb(), { trigger }, deps);
  if (out.status !== 'done') throw new Error(`sweep refused: ${out.status}`);
  return out.run;
}

function lead(id: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM job_leads WHERE source_job_id = ?').get(id) as Record<string, unknown>;
}

function setLead(id: string, fields: Record<string, unknown>): void {
  const sets = Object.keys(fields)
    .map((k) => `${k} = @${k}`)
    .join(', ');
  getDb()
    .prepare(`UPDATE job_leads SET ${sets} WHERE source_job_id = @id`)
    .run({ ...fields, id });
}

describe('sweepWatchlist — inserts + the run row', () => {
  it('inserts only direct board rows (company from the watchlist row) and writes a finished run row', async () => {
    addBoard('acme', 'Acme');
    const run = await sweep(boards({ acme: ok([posting('acme', '1'), posting('acme', '2')]) }));

    expect(run).toMatchObject({ ok: true, boards_ok: 1, boards_failed: 0, new: 2 });
    const rows = getDb().prepare('SELECT source, company, apply_link_kind FROM job_leads').all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r as { apply_link_kind: string }).apply_link_kind === 'ats')).toBe(true);
    expect(rows.every((r) => (r as { company: string }).company === 'Acme')).toBe(true);
    const kinds = getDb().prepare(`SELECT DISTINCT apply_link_kind AS k FROM job_leads`).all() as Array<{ k: string }>;
    expect(kinds.map((k) => k.k).every((k) => k === 'ats' || k === 'company')).toBe(true);

    const row = getDb().prepare(`SELECT * FROM lead_source_runs WHERE id = ?`).get(run.id) as Record<string, unknown>;
    expect(row).toMatchObject({ kind: 'sweep', trigger: 'manual', ok: 1, boards_ok: 1, new_count: 2 });
    expect(row.finished_at).toBeTruthy();
    expect(readLastSweep(getDb())).toMatchObject({ id: run.id, ok: true, trigger: 'manual', new: 2 });
    // The board row records the successful fetch and what it yielded.
    expect(getBoard(getDb(), 'greenhouse', 'acme')).toMatchObject({ leads_found: 2, consecutive_failures: 0 });
    expect(getBoard(getDb(), 'greenhouse', 'acme')?.last_ok_at).toBeTruthy();
  });

  it('spends the per-run cap on the NEWEST postings across every board, not on the first board', async () => {
    // Watchlist order is tier, company: Acme is swept first and alone could fill the cap.
    addBoard('acme', 'Acme');
    addBoard('globex', 'Globex');
    setPref('ats_sweep_max_new_per_run', 3);
    const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();
    const run = await sweep(
      boards({
        acme: ok([
          posting('acme', 'a-old-1', { source_posted_at: hoursAgo(200) }),
          posting('acme', 'a-old-2', { source_posted_at: hoursAgo(190) }),
          posting('acme', 'a-old-3', { source_posted_at: hoursAgo(180) }),
          posting('acme', 'a-fresh', { source_posted_at: hoursAgo(3) }),
          posting('acme', 'a-undated', { source_posted_at: null }),
        ]),
        globex: ok([
          posting('globex', 'g-fresh-1', { source_posted_at: hoursAgo(1) }),
          posting('globex', 'g-fresh-2', { source_posted_at: hoursAgo(2) }),
        ]),
      }),
    );
    expect(run.new).toBe(3);
    expect(run.rejected).toEqual({ cap: 4 });
    const stored = (
      getDb().prepare('SELECT source_job_id FROM job_leads ORDER BY source_job_id').all() as Array<{
        source_job_id: string;
      }>
    ).map((r) => r.source_job_id);
    expect(stored).toEqual(['a-fresh', 'g-fresh-1', 'g-fresh-2']);
    // Each board's row records what IT yielded.
    expect(getBoard(getDb(), 'greenhouse', 'acme')).toMatchObject({ leads_found: 1 });
    expect(getBoard(getDb(), 'greenhouse', 'globex')).toMatchObject({ leads_found: 2 });

    // The next run takes the next-newest of what was left, undated last.
    const second = await sweep(
      boards({
        acme: ok([
          posting('acme', 'a-old-1', { source_posted_at: hoursAgo(200) }),
          posting('acme', 'a-old-2', { source_posted_at: hoursAgo(190) }),
          posting('acme', 'a-old-3', { source_posted_at: hoursAgo(180) }),
          posting('acme', 'a-fresh', { source_posted_at: hoursAgo(3) }),
          posting('acme', 'a-undated', { source_posted_at: null }),
        ]),
        globex: ok([
          posting('globex', 'g-fresh-1', { source_posted_at: hoursAgo(1) }),
          posting('globex', 'g-fresh-2', { source_posted_at: hoursAgo(2) }),
        ]),
      }),
    );
    expect(second.new).toBe(3);
    expect(second.rejected).toEqual({ cap: 1 });
    expect(lead('a-undated')).toBeUndefined();
  });

  it('filters new postings by title, location and age, caps the run, and counts each rejection by reason', async () => {
    addBoard('acme', 'Acme');
    setPref('ats_sweep_title_include', '\\bengineer\\b');
    setPref('ats_sweep_title_exclude', '\\bsales\\b');
    setPref('ats_sweep_location_filter', 'remote');
    setPref('ats_sweep_max_age_days', 30);
    setPref('ats_sweep_max_new_per_run', 2);
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
    const run = await sweep(
      boards({
        acme: ok([
          posting('acme', 'keep-1', { source_posted_at: daysAgo(1) }),
          posting('acme', 'designer', { title: 'Product Designer' }),
          posting('acme', 'sales', { title: 'Sales Engineer' }),
          posting('acme', 'onsite', { location_raw: 'Berlin', workplace_type: 'onsite' }),
          posting('acme', 'old', { source_posted_at: old }),
          posting('acme', 'keep-2', { source_posted_at: daysAgo(2) }),
          posting('acme', 'over-cap', { source_posted_at: daysAgo(3) }),
        ]),
      }),
    );
    expect(run.new).toBe(2);
    expect(run.rejected).toEqual({ filter: 2, location: 1, age: 1, cap: 1 });
    expect(
      (
        getDb().prepare('SELECT source_job_id FROM job_leads ORDER BY source_job_id').all() as Array<{
          source_job_id: string;
        }>
      ).map((r) => r.source_job_id),
    ).toEqual(['keep-1', 'keep-2']);
  });

  it('an uncompilable stored pattern is skipped and reported in the run row — the sweep still runs', async () => {
    addBoard('acme', 'Acme');
    // Written around the save-time validation (an older value, a manual edit).
    setPref('ats_sweep_title_include', '(unclosed');
    const run = await sweep(boards({ acme: ok([posting('acme', '1', { title: 'Office Manager' })]) }));
    expect(run.ok).toBe(true);
    expect(run.new).toBe(1); // the broken include filter was skipped, not applied
    expect(run.error).toMatch(/ats_sweep_title_include does not compile/);
    const row = getDb().prepare(`SELECT ok, error FROM lead_source_runs WHERE id = ?`).get(run.id) as {
      ok: number;
      error: string;
    };
    expect(row.ok).toBe(1);
    expect(row.error).toMatch(/does not compile/);
  });

  it('a tombstoned board posting is not re-inserted by the next sweep', async () => {
    addBoard('acme', 'Acme');
    writeTombstone(getDb(), {
      source: 'greenhouse',
      source_job_id: 'gone-1',
      content_fingerprint: null,
      company: 'Acme',
      title: 'Senior Software Engineer gone-1',
      reason: 'deleted',
      match: 'id',
    });
    const run = await sweep(boards({ acme: ok([posting('acme', 'gone-1'), posting('acme', 'fresh')]) }));
    expect(run.new).toBe(1);
    expect(run.rejected).toEqual({ tombstone: 1 });
    expect(lead('gone-1')).toBeUndefined();
    expect(lead('fresh')).toBeDefined();
  });
});

describe('sweepWatchlist — presence and close-on-absence', () => {
  it('a board lead seen by two ok sweeps 15 days apart is refreshed and not closed by the stale rule', async () => {
    addBoard('acme', 'Acme');
    const t0 = new Date(Date.now() - 15 * 86_400_000);
    await sweep(boards({ acme: ok([posting('acme', 'p1')]) }, t0));
    setLead('p1', { last_seen_at: t0.toISOString() });

    const t1 = new Date();
    const run = await sweep(boards({ acme: ok([posting('acme', 'p1')]) }, t1));
    expect(run.refreshed).toBe(1);
    expect(run.new).toBe(0);
    expect(lead('p1').last_seen_at).toBe(t1.toISOString());

    const { whereSql, params } = buildCloseStaleEligibilityClause(14, t1);
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM job_leads WHERE ${whereSql}`).get(params) as { n: number }).n;
    expect(n).toBe(0);
    expect(lead('p1').closed_at).toBeNull();
  });

  it('closes on an ok fetch, never a promoted lead; surfaces a queued one; reopens on return', async () => {
    addBoard('acme', 'Acme');
    await sweep(boards({ acme: ok(['a', 'b', 'q', 'stay'].map((id) => posting('acme', id))) }));
    getDb().pragma('foreign_keys = OFF'); // a promoted lead without seeding an application row
    setLead('b', { application_id: 'app-1', status: 'applied' });
    setLead('q', { status: 'queued' });

    const run = await sweep(boards({ acme: ok([posting('acme', 'stay')]) }));
    expect(run.closed).toBe(1);
    expect(lead('a')).toMatchObject({ closed_reason: 'absent' });
    expect(lead('b').closed_at).toBeNull();
    expect(lead('q').closed_at).toBeNull();
    expect(run.queued_absent.map((x) => x.id)).toEqual([lead('q').id]);
    expect(
      JSON.parse(
        (
          getDb().prepare('SELECT queued_absent_json AS j FROM lead_source_runs WHERE id = ?').get(run.id) as {
            j: string;
          }
        ).j,
      ),
    ).toHaveLength(1);

    const back = await sweep(boards({ acme: ok([posting('acme', 'stay'), posting('acme', 'a')]) }));
    expect(back.reopened).toBe(1);
    expect(back.new).toBe(0);
    expect(lead('a')).toMatchObject({ closed_at: null, closed_reason: null });
  });

  it('a 429 closes nothing and is reported as a failing board', async () => {
    addBoard('acme', 'Acme');
    await sweep(boards({ acme: ok([posting('acme', 'a')]) }));
    const run = await sweep(boards({ acme: http429 }));
    expect(run).toMatchObject({ boards_ok: 0, boards_failed: 1, closed: 0 });
    expect(run.failing_boards).toEqual([{ company: 'Acme', ats: 'greenhouse', error: 'HTTP 429' }]);
    expect(lead('a').closed_at).toBeNull();
    expect(getBoard(getDb(), 'greenhouse', 'acme')?.consecutive_failures).toBe(1);
  });

  it('an absent board closes nothing and is retired after ats_watchlist_retire_after failed sweeps', async () => {
    addBoard('acme', 'Acme');
    setPref('ats_watchlist_retire_after', 2);
    await sweep(boards({ acme: ok([posting('acme', 'a')]) }));
    await sweep(boards({ acme: absentBoard }));
    expect(lead('a').closed_at).toBeNull();
    expect(getBoard(getDb(), 'greenhouse', 'acme')).toMatchObject({ state: 'active', consecutive_failures: 1 });
    const run = await sweep(boards({ acme: absentBoard }));
    expect(run.failing_boards[0].error).toMatch(/board absent/);
    expect(getBoard(getDb(), 'greenhouse', 'acme')).toMatchObject({ state: 'absent', consecutive_failures: 2 });
    expect(lead('a').closed_at).toBeNull();
    // A retired board is no longer swept.
    const after = await sweep(boards({ acme: ok([]) }));
    expect(after.boards_ok + after.boards_failed).toBe(0);
  });

  it('an ok but empty response for a board with open leads is suspect: nothing is closed', async () => {
    addBoard('acme', 'Acme');
    await sweep(boards({ acme: ok([posting('acme', 'a'), posting('acme', 'b')]) }));
    const run = await sweep(boards({ acme: ok([]) }));
    expect(run.closed).toBe(0);
    expect(run.failing_boards).toEqual([
      { company: 'Acme', ats: 'greenhouse', error: 'returned no postings; nothing closed' },
    ]);
    expect(lead('a').closed_at).toBeNull();
    expect(lead('b').closed_at).toBeNull();
  });
});

describe('single flight + the pause gate', () => {
  it('a second sweep started while one runs is a no-op', async () => {
    addBoard('acme', 'Acme');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fetches = 0;
    const slow: SweepDeps = {
      listBoard: async () => {
        fetches += 1;
        await gate;
        return ok([posting('acme', 'a')]);
      },
    };
    expect(startSweep(getDb(), { trigger: 'manual' }, slow)).toEqual({ started: true });
    expect(isSweepRunning()).toBe(true);
    expect(startSweep(getDb(), { trigger: 'manual' }, slow)).toEqual({ started: false, reason: 'already_running' });
    expect(await sweepWatchlist(getDb(), { trigger: 'schedule' }, slow)).toEqual({ status: 'already_running' });
    expect(maybeStartScheduledSweep(getDb(), slow)).toBe(false);
    release();
    await _awaitInFlightSweepForTesting();
    expect(isSweepRunning()).toBe(false);
    expect(fetches).toBe(1);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM lead_source_runs`).get() as { n: number }).n).toBe(1);
  });

  it('nothing starts under halted or killswitch', async () => {
    addBoard('acme', 'Acme');
    for (const state of ['halted', 'killswitch'] as const) {
      setPauseState(state);
      expect(startSweep(getDb(), { trigger: 'manual' }, boards({}))).toEqual({ started: false, reason: 'halted' });
      expect(await sweepWatchlist(getDb(), { trigger: 'manual' }, boards({}))).toEqual({ status: 'halted' });
      expect(maybeStartScheduledSweep(getDb(), boards({}))).toBe(false);
    }
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM lead_source_runs`).get() as { n: number }).n).toBe(0);
    // A soft pause does not stop it — the sweep is LLM-free.
    setPauseState('paused');
    expect(startSweep(getDb(), { trigger: 'manual' }, boards({})).started).toBe(true);
    await _awaitInFlightSweepForTesting();
  });
});

describe('the schedule', () => {
  it('isScheduledSweepDue: due once past an occurrence the newest run predates', () => {
    const now = new Date('2026-11-16T10:30:00Z');
    expect(isScheduledSweepDue('0 */2 * * *', null, now, 'UTC')).toBe(true);
    expect(isScheduledSweepDue('0 */2 * * *', '2026-11-16T10:00:05Z', now, 'UTC')).toBe(false);
    expect(isScheduledSweepDue('0 */2 * * *', '2026-11-16T09:59:00Z', now, 'UTC')).toBe(true);
    expect(isScheduledSweepDue('not a cron', null, now, 'UTC')).toBe(false);
  });

  it('starts one detached run when due and returns without waiting for it', async () => {
    addBoard('acme', 'Acme');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: SweepDeps = {
      listBoard: async () => {
        await gate;
        return ok([]);
      },
    };
    // Returns synchronously while the board fetch is still blocked.
    expect(maybeStartScheduledSweep(getDb(), deps)).toBe(true);
    expect(isSweepRunning()).toBe(true);
    release();
    await _awaitInFlightSweepForTesting();
    expect(readLastSweep(getDb())).toMatchObject({ trigger: 'schedule', ok: true });
    // Just ran → not due again until the next occurrence.
    expect(maybeStartScheduledSweep(getDb(), deps)).toBe(false);
  });

  it('a resume after a long standby fires ONE catch-up run, not one per missed occurrence', async () => {
    addBoard('acme', 'Acme');
    // The last sweep ran three days ago — 36 two-hourly occurrences missed.
    getDb()
      .prepare(
        `INSERT INTO lead_source_runs (id, kind, trigger, started_at, finished_at, ok) VALUES ('old', 'sweep', 'schedule', ?, ?, 1)`,
      )
      .run(new Date(Date.now() - 3 * 86_400_000).toISOString(), new Date(Date.now() - 3 * 86_400_000).toISOString());
    const deps = boards({ acme: ok([]) });
    let started = 0;
    for (let tick = 0; tick < 5; tick++) {
      if (maybeStartScheduledSweep(getDb(), deps)) started += 1;
      await _awaitInFlightSweepForTesting();
    }
    expect(started).toBe(1);
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM lead_source_runs WHERE kind = 'sweep'`).get() as { n: number }).n,
    ).toBe(2);
  });

  it('does nothing when switched off; settles a run row orphaned by a restart', async () => {
    addBoard('acme', 'Acme');
    getDb()
      .prepare(`INSERT INTO lead_source_runs (id, kind, trigger, started_at) VALUES ('orphan', 'sweep', 'schedule', ?)`)
      .run(new Date().toISOString());
    setPref('ats_sweep_enabled', false);
    expect(maybeStartScheduledSweep(getDb(), boards({}))).toBe(false);
    const row = getDb().prepare(`SELECT ok, error FROM lead_source_runs WHERE id = 'orphan'`).get() as {
      ok: number;
      error: string;
    };
    expect(row.ok).toBe(0);
    expect(row.error).toMatch(/interrupted/);
  });
});

describe('a sweep that reached no board is not a success (§24.201 D8 freshness)', () => {
  it('every board failing records ok=0, so health and /architecture read the outage as stale', async () => {
    addBoard('acme', 'Acme');
    addBoard('globex', 'Globex');
    const run = await sweep(boards({ acme: http429, globex: http429 }));
    expect(run).toMatchObject({ ok: false, boards_ok: 0, boards_failed: 2 });
    expect(run.error).toMatch(/every board fetch failed \(2 of 2\)/);
    expect(readLastSweep(getDb())).toMatchObject({ ok: false });
    expect(readLastSuccessfulSweepAt(getDb())).toBeNull();
    // A transient outage never retires a board.
    expect(getBoard(getDb(), 'greenhouse', 'acme')).toMatchObject({ state: 'active', consecutive_absent: 0 });
  });

  it('one board fetching ok is still a successful run; no active boards is ok too', async () => {
    const empty = await sweep(boards({}));
    expect(empty.ok).toBe(true);
    addBoard('acme', 'Acme');
    addBoard('globex', 'Globex');
    const run = await sweep(boards({ acme: ok([posting('acme', '1')]), globex: http429 }));
    expect(run).toMatchObject({ ok: true, boards_ok: 1, boards_failed: 1 });
    expect(readLastSuccessfulSweepAt(getDb())).not.toBeNull();
  });
});

describe('a posting already in the pool as a search hit is not inserted twice', () => {
  function searchCopy(id: string, url: string): string {
    const res = upsertJobLead(getDb(), {
      source: 'google_jobs',
      source_board_token: null,
      source_job_id: id,
      source_url: 'https://www.google.com/search?q=jobs',
      apply_url: url,
      apply_link_kind: 'ats',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      location_raw: 'Remote - US',
      description_text: 'A search snippet, not the full board description.',
      source_posted_at: new Date().toISOString(),
    });
    if (!res.recorded) throw new Error(res.reason);
    return res.id;
  }

  it('a not-interested search copy keeps the board posting out; an open copy is refreshed instead', async () => {
    addBoard('acme', 'Acme');
    searchCopy('gj-archived', 'https://job-boards.greenhouse.io/acme/jobs/123?gh_src=abc');
    setLead('gj-archived', {
      status: 'archived',
      closed_at: new Date().toISOString(),
      closed_reason: 'not_interested:role',
    });
    const openId = searchCopy('gj-open', 'https://boards.greenhouse.io/embed/job_app?for=ACME&token=456');
    setLead('gj-open', { last_seen_at: '2026-01-01T00:00:00.000Z' });

    const run = await sweep(
      boards({ acme: ok([posting('acme', '123'), posting('acme', '456'), posting('acme', '789')]) }),
    );
    expect(run.new).toBe(1); // only 789 is genuinely new
    const greenhouse = getDb()
      .prepare(`SELECT source_job_id FROM job_leads WHERE source = 'greenhouse' ORDER BY source_job_id`)
      .all() as Array<{ source_job_id: string }>;
    expect(greenhouse.map((r) => r.source_job_id)).toEqual(['789']);
    // The open copy is evidence the job is live: its last_seen_at advanced.
    const open = getDb().prepare('SELECT last_seen_at FROM job_leads WHERE id = ?').get(openId) as {
      last_seen_at: string;
    };
    expect(open.last_seen_at > '2026-01-01T00:00:00.000Z').toBe(true);
    // The archived copy stays closed.
    expect(lead('gj-archived')).toMatchObject({ status: 'archived', closed_reason: 'not_interested:role' });
  });

  it('a search copy on another board or another job does not suppress the posting', async () => {
    addBoard('acme', 'Acme');
    searchCopy('gj-other-board', 'https://job-boards.greenhouse.io/globex/jobs/123');
    searchCopy('gj-other-job', 'https://job-boards.greenhouse.io/acme/jobs/999');
    const run = await sweep(boards({ acme: ok([posting('acme', '123')]) }));
    expect(run.new).toBe(1);
  });
});
