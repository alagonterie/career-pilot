/**
 * The watchlist grows by itself (STRATEGY.md §24.200 D7, slice c DoD):
 *   - a search hit whose link is already a direct ATS link yields its board
 *     (origin 'search'), bounded by ats_watchlist_max_auto_adds_per_run and
 *     ats_watchlist_max_boards, the excess recorded as rejected 'watchlist_cap'
 *     on the search's run row; a paused or retired board is never re-added;
 *   - `fetch_source` reaches a board added that way;
 *   - `discover_ats_board` refuses a NEW board at the size limit;
 *   - applying from a lead promotes its board (added as 'applied', or a tier up).
 * No network: `fetch` is stubbed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import {
  ensureAtsWatchlistSeeded,
  findBoard,
  listWatchlist,
  markBoardRemoved,
  promoteBoardForAppliedLead,
  upsertBoard,
} from './ats-watchlist.js';
import { handleDiscoverAtsBoard, handleFetchSource, handleStashJobPayloads } from './job-lead-actions.js';
import { reactToStatusTransitions } from './interview-kit-trigger.js';
import * as payloadCache from './scrape-jobs/payload-cache.js';
import { _clearCache } from './scrape-jobs/sources.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-watchlist-growth-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');
const emptySeed = path.join(tmpDir, 'empty-seed.json');
const SESSION = { id: 's', agent_group_id: 'g' } as unknown as Session;
let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(emptySeed, '[]');
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  ensureAtsWatchlistSeeded(getDb(), emptySeed);
  payloadCache.clear();
  _clearCache();
  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Frame = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

async function call(
  handler: (c: Record<string, unknown>, s: Session, d: Database.Database) => Promise<void>,
  payload: Record<string, unknown>,
): Promise<Frame> {
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  await handler({ requestId, payload }, SESSION, inDb);
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as {
    content: string;
  };
  return (JSON.parse(row.content) as { frame: Frame }).frame;
}

function setPref(key: string, value: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, String(value), new Date().toISOString());
}

/** A search hit (google_jobs) whose apply link is a Greenhouse posting on `token`. */
function atsHit(id: string, token: string, company = 'Acme') {
  return {
    source: 'google_jobs',
    source_board_token: null,
    source_job_id: `g-${id}`,
    source_url: `https://www.example.com/search/${id}`,
    apply_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    apply_link_kind: 'ats',
    title: `Backend Engineer ${id}`,
    company,
    description_text: `Posting ${id} with words`,
    raw_payload: { via: 'via Greenhouse' },
  };
}

function lastSearchRejected(): Record<string, number> {
  const r = getDb()
    .prepare(`SELECT rejected_json FROM lead_source_runs WHERE kind = 'search' ORDER BY started_at DESC LIMIT 1`)
    .get() as { rejected_json: string };
  return JSON.parse(r.rejected_json) as Record<string, number>;
}

describe('growth from ats-kind search hits', () => {
  it('adds each distinct board once as origin search; ignores company-site and aggregator hits', async () => {
    const frame = await call(handleStashJobPayloads, {
      payloads: [
        atsHit('1', 'acme', 'Acme'),
        atsHit('2', 'acme', 'Acme'), // same board
        atsHit('3', 'globex', 'Globex'),
        { ...atsHit('4', 'initech'), apply_link_kind: 'company' }, // not an ats-kind hit
        { ...atsHit('5', 'hooli'), apply_url: 'https://careers.example.com/jobs/5' }, // ats-kind but no ATS URL
      ],
    });
    expect(frame).toMatchObject({ ok: true, data: { boards_added: 2 } });
    const rows = listWatchlist(getDb());
    expect(rows.map((r) => [r.token, r.origin, r.state, r.company]).sort()).toEqual([
      ['acme', 'search', 'active', 'Acme'],
      ['globex', 'search', 'active', 'Globex'],
    ]);
    expect(lastSearchRejected().watchlist_cap).toBeUndefined();
  });

  it('holds the per-run cap and records the excess as rejected watchlist_cap', async () => {
    setPref('ats_watchlist_max_auto_adds_per_run', 2);
    await call(handleStashJobPayloads, {
      payloads: [atsHit('1', 'a1'), atsHit('2', 'a2'), atsHit('3', 'a3'), atsHit('4', 'a4')],
    });
    expect(listWatchlist(getDb())).toHaveLength(2);
    expect(lastSearchRejected().watchlist_cap).toBe(2);
  });

  it('a per-run cap of 0 turns automatic growth off', async () => {
    setPref('ats_watchlist_max_auto_adds_per_run', 0);
    await call(handleStashJobPayloads, { payloads: [atsHit('1', 'a1')] });
    expect(listWatchlist(getDb())).toHaveLength(0);
    expect(lastSearchRejected().watchlist_cap).toBe(1);
  });

  it('holds the total cap (retired boards not counted)', async () => {
    setPref('ats_watchlist_max_boards', 2);
    const db = getDb();
    upsertBoard(db, { ats: 'lever', token: 'one', company: 'One', origin: 'owner' });
    const retired = upsertBoard(db, { ats: 'lever', token: 'gone', company: 'Gone', origin: 'owner' });
    if (!retired.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'absent' WHERE id = ?").run(retired.row.id);

    await call(handleStashJobPayloads, { payloads: [atsHit('1', 'a1'), atsHit('2', 'a2')] });
    expect(findBoard(db, 'greenhouse', 'a1')).toBeTruthy();
    expect(findBoard(db, 'greenhouse', 'a2')).toBeUndefined();
    expect(lastSearchRejected().watchlist_cap).toBe(1);
  });

  it('never re-adds or reactivates a board the owner paused, nor a retired one', async () => {
    const db = getDb();
    const paused = upsertBoard(db, { ats: 'greenhouse', token: 'Acme', company: 'Acme', origin: 'seed' });
    const retired = upsertBoard(db, { ats: 'greenhouse', token: 'globex', company: 'Globex', origin: 'seed' });
    if (!paused.ok || !retired.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(paused.row.id);
    db.prepare("UPDATE ats_watchlist SET state = 'absent' WHERE id = ?").run(retired.row.id);

    const frame = await call(handleStashJobPayloads, { payloads: [atsHit('1', 'acme'), atsHit('2', 'globex')] });
    expect(frame).toMatchObject({ ok: true, data: { boards_added: 0 } });
    expect(
      listWatchlist(db)
        .map((r) => [r.token, r.state])
        .sort(),
    ).toEqual([
      ['Acme', 'paused'],
      ['globex', 'absent'],
    ]);
  });

  it('fetch_source reaches a board added from a search hit (no file edit)', async () => {
    await call(handleStashJobPayloads, { payloads: [atsHit('1', 'acme', 'Acme')] });
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain('boards-api.greenhouse.io/v1/boards/acme/jobs');
      return new Response(
        JSON.stringify({
          jobs: [
            {
              id: 1,
              title: 'Backend Engineer',
              absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
              location: { name: 'Remote' },
              first_published: '2026-11-15T00:00:00Z',
              updated_at: '2026-11-15T00:00:00Z',
              content: '',
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchFn);
    const frame = await call(handleFetchSource, { company: 'Acme' });
    expect(frame).toMatchObject({ ok: true, data: { boards_scanned: 1 } });
    if (!frame.ok) throw new Error('unreachable');
    expect(frame.data.summaries).toEqual([expect.objectContaining({ source: 'greenhouse', company: 'Acme' })]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('discover_ats_board at the size limit', () => {
  it('refuses a NEW board past ats_watchlist_max_boards but still answers a listed one', async () => {
    setPref('ats_watchlist_max_boards', 1);
    const db = getDb();
    upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'owner' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })),
    );
    const full = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.ashbyhq.com/initech' });
    expect(full).toMatchObject({ ok: true, data: { added: false, reason: 'watchlist_full', max_boards: 1 } });
    expect(findBoard(db, 'ashby', 'initech')).toBeUndefined();

    const listed = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.ashbyhq.com/hooli' });
    expect(listed).toMatchObject({ ok: true, data: { already_listed: true } });
  });
});

describe('applying from a lead promotes its board', () => {
  function insertLead(id: string, over: Record<string, unknown>): void {
    const row = {
      id,
      source: 'google_jobs',
      source_board_token: null,
      source_job_id: id,
      source_url: 'https://www.example.com/x',
      apply_url: null,
      apply_link_kind: 'ats',
      title: 'Backend Engineer',
      company: 'Acme',
      ...over,
    };
    getDb()
      .prepare(
        `INSERT INTO job_leads (id, source, source_board_token, source_job_id, source_url, apply_url, apply_link_kind,
           content_fingerprint, title, company, first_seen_at, last_seen_at, status, status_changed_at)
         VALUES (@id, @source, @source_board_token, @source_job_id, @source_url, @apply_url, @apply_link_kind,
           '0000000000000000', @title, @company, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'new', '2026-11-01T00:00:00Z')`,
      )
      .run(row);
  }

  it('adds an unlisted board as origin applied (from the lead’s direct ATS link)', () => {
    insertLead('l1', { apply_url: 'https://jobs.lever.co/globex/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' });
    expect(promoteBoardForAppliedLead(getDb(), 'l1')).toEqual({
      action: 'added',
      ats: 'lever',
      token: 'globex',
      tier: 'B',
    });
    expect(findBoard(getDb(), 'lever', 'globex')).toMatchObject({
      origin: 'applied',
      state: 'active',
      company: 'Acme',
    });
  });

  it('raises a listed active board one tier; leaves a paused board alone', () => {
    const db = getDb();
    upsertBoard(db, { ats: 'greenhouse', token: 'acme', company: 'Acme', origin: 'seed', tier: 'C' });
    insertLead('l2', { source: 'greenhouse', source_board_token: 'acme', source_job_id: '9' });
    expect(promoteBoardForAppliedLead(db, 'l2')).toMatchObject({ action: 'tier_raised', tier: 'B' });
    expect(findBoard(db, 'greenhouse', 'acme')?.tier).toBe('B');

    const paused = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'seed', tier: 'C' });
    if (!paused.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(paused.row.id);
    insertLead('l3', { source: 'ashby', source_board_token: 'hooli', source_job_id: 'h' });
    expect(promoteBoardForAppliedLead(db, 'l3')).toMatchObject({ action: 'unchanged', reason: 'paused' });
    expect(findBoard(db, 'ashby', 'hooli')).toMatchObject({ state: 'paused', tier: 'C' });
  });

  it('does nothing for a lead with no board, and respects the size limit', () => {
    insertLead('l4', { apply_link_kind: 'company', apply_url: 'https://careers.example.com/1' });
    expect(promoteBoardForAppliedLead(getDb(), 'l4')).toBeNull();
    setPref('ats_watchlist_max_boards', 1);
    upsertBoard(getDb(), { ats: 'lever', token: 'one', company: 'One', origin: 'owner' });
    insertLead('l5', { apply_url: 'https://job-boards.greenhouse.io/initech/jobs/5' });
    expect(promoteBoardForAppliedLead(getDb(), 'l5')).toMatchObject({ action: 'unchanged', reason: 'cap_reached' });
    expect(findBoard(getDb(), 'greenhouse', 'initech')).toBeUndefined();
  });
});

// ── review hardening: case, region, the cap on revival, owner removals, the agent path ──

describe('the watchlist key is case-insensitive', () => {
  it('discover of a mixed-case link onto an owner-paused board leaves ONE row, still paused, without a fetch', async () => {
    const db = getDb();
    const paused = upsertBoard(db, { ats: 'lever', token: 'acme', company: 'Acme', origin: 'owner' });
    if (!paused.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(paused.row.id);
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);

    const frame = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.lever.co/Acme' });
    expect(frame).toMatchObject({
      ok: true,
      data: { added: false, blocked_by_owner: true, state: 'paused', watchlist_id: paused.row.id },
    });
    expect(listWatchlist(db).map((r) => [r.token, r.state])).toEqual([['acme', 'paused']]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('upsertBoard returns the existing row for a token differing only in case; the table refuses a raw duplicate', () => {
    const db = getDb();
    const a = upsertBoard(db, { ats: 'greenhouse', token: 'Acme', company: 'Acme', origin: 'seed' });
    const b = upsertBoard(db, { ats: 'greenhouse', token: 'acme', company: 'Acme', origin: 'owner' });
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(b).toMatchObject({ inserted: false, row: { id: a.row.id, origin: 'seed' } });
    expect(() =>
      db
        .prepare(
          `INSERT INTO ats_watchlist (ats, token, company, tier, origin, state, created_at, updated_at)
           VALUES ('greenhouse', 'ACME', 'Acme', 'B', 'owner', 'active', 'x', 'x')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('migration 156 merges existing case-duplicates into the oldest row, keeping an owner pause', async () => {
    const { migration156 } = await import('../../db/migrations/156-ats-watchlist-ci.js');
    const db = getDb();
    db.exec('DROP INDEX ux_ats_watchlist_ats_token_ci; DROP TABLE ats_watchlist_removed');
    const ins = db.prepare(
      `INSERT INTO ats_watchlist (ats, token, company, tier, origin, state, created_at, updated_at)
       VALUES ('lever', ?, 'Acme', 'B', ?, ?, 'x', 'x')`,
    );
    const first = ins.run('Acme', 'seed', 'active').lastInsertRowid;
    ins.run('acme', 'owner', 'paused');
    migration156.up(db);
    expect(db.prepare('SELECT id, token, state FROM ats_watchlist').all()).toEqual([
      { id: Number(first), token: 'Acme', state: 'paused' },
    ]);
  });
});

describe('EU-region boards are recognised but never added', () => {
  it('growth skips an ats-kind hit on an EU host; discover refuses it without a fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    await call(handleStashJobPayloads, {
      payloads: [
        { ...atsHit('1', 'euco'), apply_url: 'https://jobs.eu.lever.co/euco/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' },
      ],
    });
    expect(findBoard(getDb(), 'lever', 'euco')).toBeUndefined();

    const frame = await call(handleDiscoverAtsBoard, { careers_url: 'https://job-boards.eu.greenhouse.io/euco' });
    expect(frame).toMatchObject({ ok: true, data: { added: false, reason: 'eu_board_unsupported' } });
    expect(findBoard(getDb(), 'greenhouse', 'euco')).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('discover_ats_board counts a revived retired board against the size limit', () => {
  it('a retired board at the cap answers watchlist_full and stays absent', async () => {
    setPref('ats_watchlist_max_boards', 1);
    const db = getDb();
    upsertBoard(db, { ats: 'lever', token: 'one', company: 'One', origin: 'owner' });
    const retired = upsertBoard(db, { ats: 'ashby', token: 'initech', company: 'Initech', origin: 'owner' });
    if (!retired.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'absent' WHERE id = ?").run(retired.row.id);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })),
    );
    const frame = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.ashbyhq.com/initech' });
    expect(frame).toMatchObject({ ok: true, data: { added: false, reason: 'watchlist_full' } });
    expect(findBoard(db, 'ashby', 'initech')?.state).toBe('absent');
  });
});

describe('an owner remove sticks', () => {
  it('neither a search hit, nor applying, nor the agent’s discover adds a removed board back', async () => {
    const db = getDb();
    markBoardRemoved(db, 'greenhouse', 'NoisyCo');
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);

    const stash = await call(handleStashJobPayloads, { payloads: [atsHit('1', 'noisyco', 'NoisyCo')] });
    expect(stash).toMatchObject({ ok: true, data: { boards_added: 0 } });
    expect(findBoard(db, 'greenhouse', 'noisyco')).toBeUndefined();

    db.prepare(
      `INSERT INTO job_leads (id, source, source_board_token, source_job_id, source_url, apply_url, apply_link_kind,
         content_fingerprint, title, company, first_seen_at, last_seen_at, status, status_changed_at)
       VALUES ('l-noisy', 'google_jobs', NULL, 'g-n', 'https://www.example.com/n',
         'https://job-boards.greenhouse.io/noisyco/jobs/9', 'ats', '0000000000000000', 'Engineer', 'NoisyCo',
         '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'new', '2026-11-01T00:00:00Z')`,
    ).run();
    expect(promoteBoardForAppliedLead(db, 'l-noisy')).toMatchObject({
      action: 'unchanged',
      reason: 'removed_by_owner',
    });

    const frame = await call(handleDiscoverAtsBoard, { careers_url: 'https://job-boards.greenhouse.io/noisyco' });
    expect(frame).toMatchObject({
      ok: true,
      data: { added: false, blocked_by_owner: true, reason: 'removed_by_owner' },
    });
    expect(findBoard(db, 'greenhouse', 'noisyco')).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('an application reported to the agent promotes its lead’s board', () => {
  it('the status reactor links the lead and adds its board as origin applied', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO job_leads (id, source, source_board_token, source_job_id, source_url, apply_url, apply_link_kind,
         content_fingerprint, title, company, first_seen_at, last_seen_at, status, status_changed_at)
       VALUES ('l-agent', 'google_jobs', NULL, 'g-a', 'https://www.example.com/a',
         'https://jobs.lever.co/globex/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'ats', '0000000000000000',
         'Site Reliability Engineer', 'Globex', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'new',
         '2026-11-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO applications (id, company_name, obfuscated_label, role_title, job_url, status, created_at)
       VALUES ('app-agent', 'Globex', 'misc-a', 'Site Reliability Engineer', NULL, 'APPLIED', '2026-11-02T00:00:00Z')`,
    ).run();

    reactToStatusTransitions(db, null, [{ application_id: 'app-agent', from: null, to: 'APPLIED' }]);

    expect(db.prepare(`SELECT application_id FROM job_leads WHERE id = 'l-agent'`).get()).toEqual({
      application_id: 'app-agent',
    });
    expect(findBoard(db, 'lever', 'globex')).toMatchObject({ origin: 'applied', state: 'active' });
  });
});
