/**
 * The owner's Watchlist tab, the sweep-filter preview and "add a lead by URL"
 * (STRATEGY.md §24.201 D7 slice c; §24.202 D6 + D7). Every status-code row of
 * the contract, the preview's equality with the sweep's own filter, the
 * never-fetch rule for a non-ATS URL, and the adminEnabled() gate on the routes.
 * No network: the adapter is injected and `fetch` is stubbed to fail the test.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { evaluateSweepFilters, type CompiledSweepFilters } from '../career-pilot/ats-sweep.js';
import {
  ensureAtsWatchlistSeeded,
  findBoard,
  growWatchlistFromSearchHits,
  upsertBoard,
} from '../career-pilot/ats-watchlist.js';
import { upsertJobLead } from '../career-pilot/job-lead-actions.js';
import { appendTitleToBlocklist, writeTombstone } from '../career-pilot/lead-guard.js';
import type { AtsSource, JobLeadPayload, SourceListResult } from '../career-pilot/scrape-jobs/types.js';

import { applyAdminLeadsWriteAsync, applyAdminWatchlistWriteAsync, buildAdminWatchlist } from './admin.js';
import type { WatchlistAdminDeps } from './admin-watchlist.js';
import { startPortalApi, stopPortalApi } from './api.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-admin-watchlist-${process.pid}`);
const emptySeed = path.join(tmpDir, 'empty-seed.json');
const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-11-16T12:00:00Z');

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(emptySeed, '[]');
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  ensureAtsWatchlistSeeded(getDb(), emptySeed);
  // The host must never fetch anything itself in these tests: every board read
  // goes through the injected adapter.
  fetchSpy = vi.fn(async () => {
    throw new Error('network is off in tests');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function setPref(key: string, value: string | number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, String(value), new Date().toISOString());
}

function posting(ats: AtsSource, token: string, id: string, over: Partial<JobLeadPayload> = {}): JobLeadPayload {
  return {
    source: ats,
    source_board_token: token,
    source_job_id: id,
    source_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    apply_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    title: `Software Engineer ${id}`,
    company: '',
    location_raw: 'Remote - US',
    description_text: `Distinct description for posting ${id} with enough words to fingerprint it.`,
    source_posted_at: '2026-11-15T00:00:00.000Z',
    ...over,
  };
}

/** A fake adapter: `boards[token]` answers ok with those postings; 'gone' is absent; 'flaky' fails. */
function fakeDeps(boards: Record<string, JobLeadPayload[]> = {}): WatchlistAdminDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => NOW,
    getAdapter: (ats: AtsSource) => ({
      async list(token: string): Promise<SourceListResult> {
        calls.push(`${ats}:${token}`);
        if (token === 'gone') return { ok: false, absent: true, postings: [], status: 404, error: 'HTTP 404' };
        if (token === 'flaky') return { ok: false, absent: false, postings: [], status: 503, error: 'HTTP 503' };
        return { ok: true, absent: false, postings: boards[token] ?? [], status: 200 };
      },
    }),
  };
}

const watch = (body: unknown, deps = fakeDeps()) => applyAdminWatchlistWriteAsync(getDb(), body, deps);

// ── read ───────────────────────────────────────────────────────────────────

describe('GET watchlist view', () => {
  it('orders by state, tier, company; counts by state and origin; counts open leads; builds board pages', () => {
    const db = getDb();
    upsertBoard(db, { ats: 'greenhouse', token: 'acme', company: 'Acme', origin: 'seed', tier: 'B' });
    upsertBoard(db, { ats: 'lever', token: 'globex', company: 'Globex', origin: 'owner', tier: 'A' });
    const p = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'search', tier: 'A' });
    if (!p.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(p.row.id);
    upsertJobLead(db, { ...posting('greenhouse', 'Acme', '1'), company: 'Acme' });
    upsertJobLead(db, { ...posting('greenhouse', 'acme', '2'), company: 'Acme' });
    db.prepare(`UPDATE job_leads SET closed_at = ? WHERE source_job_id = '2'`).run(NOW.toISOString());

    const v = buildAdminWatchlist(db);
    expect(v.boards.map((b) => b.token)).toEqual(['globex', 'acme', 'hooli']);
    expect(v.boards.find((b) => b.token === 'acme')).toMatchObject({
      open_leads: 1,
      board_url: 'https://job-boards.greenhouse.io/acme',
    });
    expect(v.boards.find((b) => b.token === 'globex')?.board_url).toBe('https://jobs.lever.co/globex');
    expect(v.counts).toEqual({
      total: 3,
      active: 2,
      paused: 1,
      absent: 0,
      by_origin: { seed: 1, owner: 1, search: 1 },
    });
    expect(v.caps).toEqual({ max_boards: 200, counted: 3, max_auto_adds_per_run: 5 });
  });

  it('serves an empty view on an un-migrated table', () => {
    getDb().exec('DROP TABLE ats_watchlist');
    expect(buildAdminWatchlist(getDb())).toMatchObject({
      boards: [],
      counts: { total: 0, active: 0, paused: 0, absent: 0, by_origin: {} },
      caps: { counted: 0 },
    });
  });
});

// ── add_by_url ─────────────────────────────────────────────────────────────

describe('add_by_url', () => {
  it('rejects bodies and unknown actions with the shared codes', async () => {
    expect(await watch(null)).toEqual({ status: 400, body: { error: 'expected a JSON object { action }' } });
    expect(await watch({ action: 'nope' })).toEqual({ status: 400, body: { error: 'unknown action: nope' } });
  });

  it('walks the refusal table in order, never calling the adapter or fetch before the verify step', async () => {
    const deps = fakeDeps();
    const r = async (body: Record<string, unknown>) => watch({ action: 'add_by_url', ...body }, deps);
    expect(await r({})).toMatchObject({ status: 400, body: { error: 'url_required' } });
    expect(await r({ url: 'x'.repeat(2001) })).toMatchObject({ status: 400, body: { error: 'url_required' } });
    for (const url of [
      'https://www.example.com/careers',
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/?next=https://jobs.ashbyhq.com/hooli',
    ]) {
      expect(await r({ url })).toMatchObject({
        status: 400,
        body: { error: 'not_board_url', message: expect.stringContaining('Other career sites are not fetched') },
      });
    }
    expect(await r({ url: 'https://jobs.ashbyhq.com/-bad' })).toMatchObject({
      status: 400,
      body: { error: 'bad_token' },
    });
    expect(await r({ url: 'https://jobs.ashbyhq.com/hooli', company: '   ' })).toMatchObject({
      status: 400,
      body: { error: 'bad_company' },
    });
    expect(await r({ url: 'https://jobs.ashbyhq.com/hooli', tier: 'Z' })).toMatchObject({
      status: 400,
      body: { error: 'bad_tier' },
    });
    expect(deps.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds a verified board as origin owner, defaulting tier B and a title-cased company', async () => {
    const deps = fakeDeps({ 'acme-robotics': [] });
    const out = await watch({ action: 'add_by_url', url: 'https://boards.greenhouse.io/Acme-Robotics/jobs/123' }, deps);
    expect(out).toMatchObject({
      status: 200,
      body: {
        ok: true,
        inserted: true,
        reactivated: false,
        board: {
          ats: 'greenhouse',
          token: 'acme-robotics',
          company: 'Acme Robotics',
          tier: 'B',
          origin: 'owner',
          state: 'active',
          board_url: 'https://job-boards.greenhouse.io/acme-robotics',
        },
      },
    });
    expect(deps.calls).toEqual(['greenhouse:acme-robotics']);
    expect(findBoard(getDb(), 'greenhouse', 'acme-robotics')?.last_ok_at).toBe(NOW.toISOString());
  });

  it('409 already_listed for an active or paused row (no fetch)', async () => {
    const db = getDb();
    const p = upsertBoard(db, { ats: 'lever', token: 'Globex', company: 'Globex', origin: 'seed' });
    if (!p.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(p.row.id);
    const deps = fakeDeps();
    const out = await watch({ action: 'add_by_url', url: 'https://jobs.lever.co/globex' }, deps);
    expect(out).toMatchObject({
      status: 409,
      body: { error: 'already_listed', board: { id: p.row.id, state: 'paused' } },
    });
    expect(deps.calls).toEqual([]);
  });

  it('409 cap_reached at ats_watchlist_max_boards (a revived retired row counts too)', async () => {
    setPref('ats_watchlist_max_boards', 1);
    const db = getDb();
    upsertBoard(db, { ats: 'lever', token: 'one', company: 'One', origin: 'owner' });
    const r = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'owner' });
    if (!r.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'absent' WHERE id = ?").run(r.row.id);
    const deps = fakeDeps({ hooli: [], two: [] });
    expect(await watch({ action: 'add_by_url', url: 'https://jobs.lever.co/two' }, deps)).toEqual({
      status: 409,
      body: { error: 'cap_reached', cap: 1, counted: 1 },
    });
    expect(await watch({ action: 'add_by_url', url: 'https://jobs.ashbyhq.com/hooli' }, deps)).toMatchObject({
      status: 409,
      body: { error: 'cap_reached' },
    });
    expect(deps.calls).toEqual([]);
  });

  it('404 board_not_found for an absent board, 502 adapter_failed for a transient failure; nothing added', async () => {
    const deps = fakeDeps();
    expect(await watch({ action: 'add_by_url', url: 'https://jobs.lever.co/gone' }, deps)).toMatchObject({
      status: 404,
      body: { error: 'board_not_found' },
    });
    expect(await watch({ action: 'add_by_url', url: 'https://jobs.lever.co/flaky' }, deps)).toMatchObject({
      status: 502,
      body: { error: 'adapter_failed', status: 503 },
    });
    expect(buildAdminWatchlist(getDb()).boards).toHaveLength(0);
  });

  it('reactivates a retired row that verifies, with streaks reset', async () => {
    const db = getDb();
    const r = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'seed' });
    if (!r.ok) throw new Error('unreachable');
    db.prepare(
      "UPDATE ats_watchlist SET state = 'absent', consecutive_absent = 12, consecutive_failures = 12 WHERE id = ?",
    ).run(r.row.id);
    const out = await watch({ action: 'add_by_url', url: 'https://jobs.ashbyhq.com/hooli' }, fakeDeps({ hooli: [] }));
    expect(out).toMatchObject({
      status: 200,
      body: { inserted: false, reactivated: true, board: { state: 'active', consecutive_absent: 0, origin: 'seed' } },
    });
  });
});

// ── set_state / remove ─────────────────────────────────────────────────────

describe('set_state and remove', () => {
  it('validates ids and states, 404s an unknown id, pauses and resumes', async () => {
    const r = upsertBoard(getDb(), { ats: 'lever', token: 'globex', company: 'Globex', origin: 'seed' });
    if (!r.ok) throw new Error('unreachable');
    const id = r.row.id;
    expect(await watch({ action: 'set_state', id: '1', state: 'paused' })).toEqual({
      status: 400,
      body: { error: 'bad_id' },
    });
    expect(await watch({ action: 'set_state', id, state: 'absent' })).toEqual({
      status: 400,
      body: { error: 'bad_state' },
    });
    expect(await watch({ action: 'set_state', id: 9999, state: 'paused' })).toEqual({
      status: 404,
      body: { error: 'not_found', id: 9999 },
    });
    expect(await watch({ action: 'set_state', id, state: 'paused' })).toMatchObject({
      status: 200,
      body: { ok: true, board: { id, state: 'paused' } },
    });
    expect(await watch({ action: 'set_state', id, state: 'active' })).toMatchObject({
      status: 200,
      body: { board: { state: 'active' } },
    });
  });

  it('refuses activating a retired row past the cap', async () => {
    setPref('ats_watchlist_max_boards', 1);
    const db = getDb();
    upsertBoard(db, { ats: 'lever', token: 'one', company: 'One', origin: 'owner' });
    const r = upsertBoard(db, { ats: 'lever', token: 'two', company: 'Two', origin: 'owner' });
    if (!r.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'absent' WHERE id = ?").run(r.row.id);
    expect(await watch({ action: 'set_state', id: r.row.id, state: 'active' })).toEqual({
      status: 409,
      body: { error: 'cap_reached', cap: 1, counted: 1 },
    });
  });

  it('removes an owner board, refuses a seed board, leaves leads alone', async () => {
    const db = getDb();
    const seed = upsertBoard(db, { ats: 'lever', token: 'globex', company: 'Globex', origin: 'seed' });
    const own = upsertBoard(db, { ats: 'greenhouse', token: 'acme', company: 'Acme', origin: 'owner' });
    if (!seed.ok || !own.ok) throw new Error('unreachable');
    upsertJobLead(db, { ...posting('greenhouse', 'acme', '1'), company: 'Acme' });
    expect(await watch({ action: 'remove', id: 'x' })).toEqual({ status: 400, body: { error: 'bad_id' } });
    expect(await watch({ action: 'remove', id: 4242 })).toEqual({
      status: 404,
      body: { error: 'not_found', id: 4242 },
    });
    expect(await watch({ action: 'remove', id: seed.row.id })).toMatchObject({
      status: 409,
      body: { error: 'seed_board' },
    });
    expect(await watch({ action: 'remove', id: own.row.id })).toEqual({
      status: 200,
      body: { ok: true, id: own.row.id, removed: true },
    });
    expect(findBoard(db, 'greenhouse', 'acme')).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_leads').get() as { n: number }).n).toBe(1);
  });
});

describe('remove sticks against automatic growth; EU boards are refused', () => {
  it('a removed search-origin board is not re-added by the next ats-kind hit, until the owner re-adds it', async () => {
    const db = getDb();
    const r = upsertBoard(db, { ats: 'greenhouse', token: 'noisyco', company: 'NoisyCo', origin: 'search' });
    if (!r.ok) throw new Error('unreachable');
    expect(await watch({ action: 'remove', id: r.row.id })).toMatchObject({ status: 200 });

    const hit = {
      source: 'google_jobs',
      apply_link_kind: 'ats',
      apply_url: 'https://job-boards.greenhouse.io/noisyco/jobs/1',
      company: 'NoisyCo',
    };
    expect(growWatchlistFromSearchHits(db, [hit]).added).toEqual([]);
    expect(findBoard(db, 'greenhouse', 'noisyco')).toBeUndefined();

    // The owner adding it back by URL is the one thing that lifts the remove.
    expect(
      await watch({ action: 'add_by_url', url: 'https://job-boards.greenhouse.io/noisyco' }, fakeDeps({ noisyco: [] })),
    ).toMatchObject({ status: 200, body: { inserted: true } });
    expect(await watch({ action: 'remove', id: findBoard(db, 'greenhouse', 'noisyco')!.id })).toMatchObject({
      status: 200,
    });
    await watch({ action: 'add_by_url', url: 'https://job-boards.greenhouse.io/noisyco' }, fakeDeps({ noisyco: [] }));
    db.prepare('DELETE FROM ats_watchlist').run();
    expect(growWatchlistFromSearchHits(db, [hit]).added).toHaveLength(1);
  });

  it('add_by_url and add_lead_by_url refuse an EU-hosted link with a plain message, before any adapter call', async () => {
    const deps = fakeDeps({ euco: [] });
    expect(await watch({ action: 'add_by_url', url: 'https://jobs.eu.lever.co/euco' }, deps)).toEqual({
      status: 400,
      body: { error: 'not_board_url', message: expect.stringContaining('EU region') },
    });
    expect(
      await applyAdminLeadsWriteAsync(
        getDb(),
        { action: 'add_lead_by_url', url: 'https://job-boards.eu.greenhouse.io/euco/jobs/5' },
        deps,
      ),
    ).toEqual({ status: 400, body: { error: 'not_posting_url', message: expect.stringContaining('EU region') } });
    expect(deps.calls).toEqual([]);
  });
});

// ── preview_filters ────────────────────────────────────────────────────────

describe('preview_filters', () => {
  function seedLeads(): void {
    const db = getDb();
    const leads: Array<[string, Partial<JobLeadPayload>]> = [
      ['1', { title: 'Senior Backend Engineer' }],
      ['2', { title: 'Account Executive' }],
      ['3', { title: 'Platform Engineer', location_raw: 'London, UK' }],
      ['4', { title: 'Data Scientist' }],
      ['5', { title: 'Backend Engineer', source_posted_at: '2026-09-01T00:00:00.000Z' }],
    ];
    for (const [id, over] of leads)
      upsertJobLead(db, { ...posting('greenhouse', 'acme', id), company: 'Acme', ...over });
    // A closed board lead and a search lead are not measured.
    upsertJobLead(db, { ...posting('greenhouse', 'acme', '6'), company: 'Acme' });
    db.prepare(`UPDATE job_leads SET closed_at = ? WHERE source_job_id = '6'`).run(NOW.toISOString());
    setPref('ats_sweep_title_include', 'engineer');
    setPref('ats_sweep_title_exclude', 'account');
    setPref('ats_sweep_location_filter', '');
    setPref('ats_sweep_max_age_days', 30);
  }

  it('counts current vs proposed with the sweep’s reasons and samples what changes; writes nothing', async () => {
    seedLeads();
    const before = getDb().prepare('SELECT key, value FROM preferences ORDER BY key').all();
    const out = await watch({
      action: 'preview_filters',
      filters: { ats_sweep_title_include: '', ats_sweep_location_filter: 'remote', ats_sweep_max_age_days: 120 },
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      total: 5,
      // stored: include 'engineer' drops 2 + 4 (filter), age drops 5 → keep 1, 3
      current: { keep: 2, drop: 3, drop_by_reason: { filter: 2, age: 1 } },
      // proposed: no include, exclude still drops 2, location drops 3, age 120 keeps 5
      proposed: { keep: 3, drop: 2, drop_by_reason: { filter: 1, location: 1 } },
      newly_dropped: 1,
      newly_kept: 2,
      sample_newly_dropped: [expect.objectContaining({ title: 'Platform Engineer', reason: 'location' })],
      sample_newly_kept: expect.arrayContaining([
        expect.objectContaining({ title: 'Data Scientist', reason: null }),
        expect.objectContaining({ title: 'Backend Engineer', reason: null }),
      ]),
    });
    expect(getDb().prepare('SELECT key, value FROM preferences ORDER BY key').all()).toEqual(before);
  });

  it('refuses an uncompilable pattern, an out-of-range number and an unknown key, naming the field', async () => {
    expect(await watch({ action: 'preview_filters', filters: { ats_sweep_title_include: '(' } })).toMatchObject({
      status: 400,
      body: { error: 'invalid_filter', field: 'ats_sweep_title_include' },
    });
    expect(await watch({ action: 'preview_filters', filters: { ats_sweep_max_age_days: 0 } })).toMatchObject({
      status: 400,
      body: { error: 'invalid_filter', field: 'ats_sweep_max_age_days' },
    });
    expect(await watch({ action: 'preview_filters', filters: { ats_sweep_cron: '* * * * *' } })).toEqual({
      status: 400,
      body: { error: 'invalid_filter', field: 'ats_sweep_cron', message: 'not a sweep filter' },
    });
  });

  it('evaluateSweepFilters is the sweep’s order: include, exclude, location, age', () => {
    const f: CompiledSweepFilters = { include: /engineer/i, exclude: /sales/i, location: /remote/i, maxAgeDays: 10 };
    expect(evaluateSweepFilters({ title: 'Designer' }, f, NOW)).toBe('filter');
    expect(evaluateSweepFilters({ title: 'Sales Engineer' }, f, NOW)).toBe('filter');
    expect(evaluateSweepFilters({ title: 'Engineer', location_raw: 'NYC' }, f, NOW)).toBe('location');
    expect(evaluateSweepFilters({ title: 'Engineer', workplace_type: 'remote' }, f, NOW)).toBeNull();
    expect(
      evaluateSweepFilters(
        { title: 'Engineer', location_raw: 'Remote', source_posted_at: '2026-10-01T00:00:00Z' },
        f,
        NOW,
      ),
    ).toBe('age');
    expect(
      evaluateSweepFilters({ title: 'Engineer', location_raw: 'Remote', source_posted_at: 'junk' }, f, NOW),
    ).toBeNull();
  });
});

// ── add_lead_by_url ────────────────────────────────────────────────────────

describe('add_lead_by_url', () => {
  const leads = (body: Record<string, unknown>, deps = fakeDeps()) =>
    applyAdminLeadsWriteAsync(getDb(), { action: 'add_lead_by_url', ...body }, deps);

  it('refuses a non-ATS URL with a plain message and never fetches it (loopback, metadata, private IP)', async () => {
    const deps = fakeDeps();
    for (const url of [
      'https://www.example.com/jobs/1',
      'http://127.0.0.1:3000/jobs/1',
      'http://169.254.169.254/latest/meta-data/iam',
      'http://192.168.1.10/careers?gh_jid=1',
    ]) {
      expect(await leads({ url }, deps)).toEqual({
        status: 400,
        body: {
          error: 'not_posting_url',
          message: 'Only Greenhouse, Lever and Ashby job links can be added. Other sites are not fetched.',
        },
      });
    }
    expect(await leads({}, deps)).toMatchObject({ status: 400, body: { error: 'url_required' } });
    expect(await leads({ url: 'https://jobs.lever.co/globex' }, deps)).toMatchObject({
      status: 400,
      body: { error: 'not_posting_url', message: expect.stringContaining('board link') },
    });
    expect(await leads({ url: `https://jobs.lever.co/-x/${UUID}` }, deps)).toMatchObject({
      status: 400,
      body: { error: 'bad_token' },
    });
    expect(await leads({ url: `https://jobs.lever.co/globex/${UUID}`, company: 7 }, deps)).toMatchObject({
      status: 400,
      body: { error: 'bad_company' },
    });
    expect(deps.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('inserts an ats-kind lead from the board fixture, bypassing the title blocklist; proposes the board', async () => {
    const db = getDb();
    appendTitleToBlocklist(db, 'Software Engineer 77');
    setPref('ats_sweep_title_include', 'nothing-matches-this');
    const deps = fakeDeps({
      'acme-robotics': [posting('greenhouse', 'acme-robotics', '77'), posting('greenhouse', 'acme-robotics', '78')],
    });
    const out = await leads({ url: 'https://job-boards.greenhouse.io/acme-robotics/jobs/77' }, deps);
    expect(out).toMatchObject({
      status: 200,
      body: {
        ok: true,
        outcome: 'created',
        lead_status: 'new',
        tombstone_cleared: false,
        board_proposed: {
          ats: 'greenhouse',
          token: 'acme-robotics',
          company: 'Acme Robotics',
          already_listed: false,
          state: null,
        },
      },
    });
    const row = db.prepare(`SELECT * FROM job_leads WHERE source_job_id = '77'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ source: 'greenhouse', apply_link_kind: 'ats', company: 'Acme Robotics' });
    expect(findBoard(db, 'greenhouse', 'acme-robotics')).toBeUndefined(); // proposed, never added
    expect(deps.calls).toEqual(['greenhouse:acme-robotics']);
  });

  it('uses the listed board’s company and reports its state', async () => {
    const r = upsertBoard(getDb(), { ats: 'greenhouse', token: 'acme', company: 'Acme Corp', origin: 'seed' });
    if (!r.ok) throw new Error('unreachable');
    const out = await leads(
      { url: 'https://boards.greenhouse.io/acme/jobs/5', company: 'Ignored' },
      fakeDeps({ acme: [posting('greenhouse', 'acme', '5')] }),
    );
    expect(out).toMatchObject({
      status: 200,
      body: { board_proposed: { company: 'Acme Corp', already_listed: true, state: 'active' } },
    });
  });

  it('clears the posting’s own tombstone, and overrides WITHOUT deleting another posting’s fingerprint tombstone', async () => {
    const db = getDb();
    const p = { ...posting('greenhouse', 'acme', '9'), company: 'Acme' };
    upsertJobLead(db, p);
    const fp = (
      db.prepare(`SELECT content_fingerprint FROM job_leads WHERE source_job_id = '9'`).get() as {
        content_fingerprint: string;
      }
    ).content_fingerprint;
    db.prepare(`DELETE FROM job_leads`).run();
    writeTombstone(db, {
      source: 'greenhouse',
      source_job_id: '9',
      content_fingerprint: fp,
      company: 'Acme',
      title: p.title,
      reason: 'not_interested:role',
      match: 'fingerprint',
    });
    writeTombstone(db, {
      source: 'greenhouse',
      source_job_id: 'other',
      content_fingerprint: fp,
      company: 'Acme',
      title: p.title,
      reason: 'deleted',
      match: 'fingerprint',
    });
    // Sanity: the writer alone refuses it.
    expect(upsertJobLead(db, p)).toMatchObject({ recorded: false, reason: 'tombstone' });

    const out = await leads(
      { url: 'https://job-boards.greenhouse.io/acme/jobs/9' },
      fakeDeps({ acme: [posting('greenhouse', 'acme', '9')] }),
    );
    expect(out).toMatchObject({ status: 200, body: { outcome: 'created', tombstone_cleared: true } });
    // Only the tombstone written for job 9 itself is gone. The one the owner's
    // hard delete of job 'other' wrote survives — and still refuses 'other', so
    // the next sweep does not bring back a posting the owner deleted.
    expect(
      db.prepare('SELECT source_job_id FROM job_lead_tombstones ORDER BY source_job_id').all() as unknown[],
    ).toEqual([{ source_job_id: 'other' }]);
    expect(upsertJobLead(db, { ...p, source_job_id: 'other' })).toMatchObject({
      recorded: false,
      reason: 'tombstone',
    });
  });

  it('an add with only another posting’s fingerprint tombstone in the way inserts and deletes nothing', async () => {
    const db = getDb();
    const p = { ...posting('greenhouse', 'acme', '31'), company: 'Acme' };
    upsertJobLead(db, p);
    const fp = (
      db.prepare(`SELECT content_fingerprint FROM job_leads WHERE source_job_id = '31'`).get() as {
        content_fingerprint: string;
      }
    ).content_fingerprint;
    db.prepare(`DELETE FROM job_leads`).run();
    writeTombstone(db, {
      source: 'greenhouse',
      source_job_id: '30',
      content_fingerprint: fp,
      company: 'Acme',
      title: p.title,
      reason: 'deleted',
      match: 'fingerprint',
    });
    const out = await leads(
      { url: 'https://job-boards.greenhouse.io/acme/jobs/31' },
      fakeDeps({ acme: [posting('greenhouse', 'acme', '31')] }),
    );
    expect(out).toMatchObject({ status: 200, body: { outcome: 'created', tombstone_cleared: true } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_lead_tombstones').get() as { n: number }).n).toBe(1);
    expect(upsertJobLead(db, { ...p, source_job_id: '30' })).toMatchObject({ recorded: false, reason: 'tombstone' });
  });

  it('already in the pool (board row or a search copy of the same job): 200 already_present, no fetch', async () => {
    const db = getDb();
    upsertJobLead(db, { ...posting('greenhouse', 'acme', '11'), company: 'Acme' });
    db.prepare(`UPDATE job_leads SET status = 'archived' WHERE source_job_id = '11'`).run();
    db.prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, apply_url, apply_link_kind, content_fingerprint,
         title, company, first_seen_at, last_seen_at, status, status_changed_at)
       VALUES ('search-copy', 'google_jobs', 'g-1', 'https://www.example.com/x', ?, 'ats', '0000000000000000',
         'Backend', 'Globex', ?, ?, 'queued', ?)`,
    ).run(`https://jobs.lever.co/globex/${UUID}/apply`, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const deps = fakeDeps();
    expect(await leads({ url: 'https://boards.greenhouse.io/acme/jobs/11' }, deps)).toMatchObject({
      status: 200,
      body: { outcome: 'already_present', lead_status: 'archived', tombstone_cleared: false },
    });
    expect(await leads({ url: `https://jobs.lever.co/GLOBEX/${UUID}` }, deps)).toMatchObject({
      status: 200,
      body: { outcome: 'already_present', lead_id: 'search-copy', lead_status: 'queued' },
    });
    expect(deps.calls).toEqual([]);
  });

  it('404 board_not_found, 502 adapter_failed, 404 posting_not_found', async () => {
    expect(await leads({ url: 'https://boards.greenhouse.io/gone/jobs/1' })).toMatchObject({
      status: 404,
      body: { error: 'board_not_found' },
    });
    expect(await leads({ url: 'https://boards.greenhouse.io/flaky/jobs/1' })).toMatchObject({
      status: 502,
      body: { error: 'adapter_failed', status: 503 },
    });
    expect(await leads({ url: 'https://boards.greenhouse.io/acme/jobs/404' }, fakeDeps({ acme: [] }))).toMatchObject({
      status: 404,
      body: { error: 'posting_not_found' },
    });
  });
});

// ── "I applied" promotes the board ─────────────────────────────────────────

describe('applied_from_lead promotes the lead’s board', () => {
  it('adds the board as origin applied and reports it', async () => {
    const db = getDb();
    const rec = upsertJobLead(db, { ...posting('greenhouse', 'acme', '21'), company: 'Acme' });
    if (!rec.recorded) throw new Error('unreachable');
    const out = await applyAdminLeadsWriteAsync(
      db,
      { action: 'applied_from_lead', lead_id: rec.id },
      { classify: async () => 'saas', scoreWinConfidence: async () => null },
    );
    expect(out).toMatchObject({
      status: 200,
      body: { ok: true, board_promotion: { action: 'added', ats: 'greenhouse', token: 'acme' } },
    });
    expect(findBoard(db, 'greenhouse', 'acme')).toMatchObject({ origin: 'applied', state: 'active' });
  });
});

// ── the gate ───────────────────────────────────────────────────────────────

describe('/api/admin/watchlist sits behind adminEnabled()', () => {
  const saved = process.env.ENVIRONMENT;
  afterEach(async () => {
    await stopPortalApi();
    if (saved === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = saved;
  });

  it('404s the read and every write off the dev stack, serves them on dev', async () => {
    vi.unstubAllGlobals(); // the test itself talks to the local server
    const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${port}`;
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    process.env.ENVIRONMENT = 'production';
    expect((await fetch(`${base}/api/admin/watchlist`)).status).toBe(404);
    expect((await post('/api/admin/watchlist', { action: 'remove', id: 1 })).status).toBe(404);
    expect((await post('/api/admin/leads', { action: 'add_lead_by_url', url: 'https://jobs.lever.co/x' })).status).toBe(
      404,
    );

    process.env.ENVIRONMENT = 'dev';
    const read = await fetch(`${base}/api/admin/watchlist`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ boards: [], counts: { total: 0 } });
    const bad = await fetch(`${base}/api/admin/watchlist`, { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid JSON body' });
    expect((await post('/api/admin/watchlist', { action: 'remove', id: 1 })).status).toBe(404); // not_found
  });
});
