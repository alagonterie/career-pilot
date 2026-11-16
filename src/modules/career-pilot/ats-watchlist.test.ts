/**
 * The employer-board watchlist store (STRATEGY.md §24.200 D7, §24.201 D4): the
 * insert-missing seed is idempotent and never overwrites a row, the readers see
 * only `active` boards, "block company" pauses a company's boards (and an
 * agent re-add never lifts that pause), only repeated "board gone" answers
 * retire a board (an outage never does), and posting URLs parse to their ATS
 * job identity.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  DEFAULT_SEED_PATH,
  ensureAtsWatchlistSeeded,
  findBoardsByCompany,
  isValidBoardToken,
  atsJobKey,
  listActiveBoards,
  parseAtsJobUrl,
  listWatchlist,
  pauseBoardsForCompany,
  recordBoardFetch,
  setBoardState,
  upsertBoard,
} from './ats-watchlist.js';
import { filterTargets } from './scrape-jobs/targets.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-watchlist-'));
function seedFile(entries: unknown): string {
  const p = path.join(tmpDir, `seed-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(entries));
  return p;
}

const SEED = [
  { company: 'Acme', source: 'greenhouse', token: 'acme', priority: 'A', notes: 'top' },
  { company: 'Globex', source: 'lever', token: 'globex', priority: 'B' },
  { company: 'Initech', source: 'ashby', token: 'initech', priority: 'C' },
  { company: 'Bad', source: 'workday', token: 'bad', priority: 'A' }, // unsupported ATS
  { company: 'Bad', source: 'lever', token: '../etc', priority: 'A' }, // malformed token
  { company: '', source: 'lever', token: 'noname', priority: 'A' }, // no company
];

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
});
afterEach(() => closeDb());
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('seed', () => {
  it('inserts the valid entries as origin seed and is idempotent', () => {
    const db = getDb();
    const file = seedFile(SEED);
    expect(ensureAtsWatchlistSeeded(db, file)).toEqual({ inserted: 3, existing: 0, invalid: 3 });
    expect(ensureAtsWatchlistSeeded(db, file)).toEqual({ inserted: 0, existing: 3, invalid: 3 });
    const rows = listWatchlist(db);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.origin === 'seed' && r.state === 'active')).toBe(true);
    expect(rows.find((r) => r.token === 'acme')).toMatchObject({ company: 'Acme', tier: 'A', notes: 'top' });
  });

  it('never overwrites an existing row — an owner pause survives a re-seed', () => {
    const db = getDb();
    const file = seedFile(SEED);
    ensureAtsWatchlistSeeded(db, file);
    const acme = listWatchlist(db).find((r) => r.token === 'acme')!;
    setBoardState(db, acme.id, 'paused');
    ensureAtsWatchlistSeeded(db, file);
    expect(listWatchlist(db).find((r) => r.token === 'acme')!.state).toBe('paused');
  });

  it('adds a board appended to the file on the next seed', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile(SEED));
    const res = ensureAtsWatchlistSeeded(
      db,
      seedFile([...SEED, { company: 'Umbrella', source: 'greenhouse', token: 'umbrella', priority: 'B' }]),
    );
    expect(res.inserted).toBe(1);
    expect(listWatchlist(db)).toHaveLength(4);
  });

  it('an unreadable seed file seeds nothing and does not throw', () => {
    const db = getDb();
    expect(ensureAtsWatchlistSeeded(db, path.join(tmpDir, 'missing.json'))).toEqual({
      inserted: 0,
      existing: 0,
      invalid: 0,
    });
  });

  it('the shipped seed file is valid and every entry seeds', () => {
    const db = getDb();
    const entries = JSON.parse(fs.readFileSync(DEFAULT_SEED_PATH, 'utf8')) as unknown[];
    const res = ensureAtsWatchlistSeeded(db);
    expect(res.invalid).toBe(0);
    expect(res.inserted).toBe(entries.length);
  });

  it('a reader seeds lazily from the shipped file when nothing seeded the handle yet', () => {
    const db = getDb();
    expect(listWatchlist(db).length).toBeGreaterThan(0);
  });
});

describe('readers', () => {
  it('listActiveBoards / filterTargets resolve only active rows, by tier and by company', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile(SEED));
    const globex = listWatchlist(db).find((r) => r.token === 'globex')!;
    setBoardState(db, globex.id, 'paused');

    expect(listActiveBoards(db).map((r) => r.token)).toEqual(['acme', 'initech']);
    expect(filterTargets({ priority: 'A' }, db)).toEqual([
      { company: 'Acme', source: 'greenhouse', token: 'acme', priority: 'A', notes: 'top' },
    ]);
    expect(filterTargets({ company: 'INITECH' }, db)).toEqual([
      { company: 'Initech', source: 'ashby', token: 'initech', priority: 'C' },
    ]);
    expect(filterTargets({ company: 'Globex' }, db)).toEqual([]); // paused
  });
});

describe('upsertBoard', () => {
  it('validates ats, token, company and tier without throwing', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile([]));
    expect(upsertBoard(db, { ats: 'workday', token: 'x', company: 'X', origin: 'owner' })).toEqual({
      ok: false,
      error: 'bad_ats',
    });
    expect(upsertBoard(db, { ats: 'lever', token: 'a b', company: 'X', origin: 'owner' })).toEqual({
      ok: false,
      error: 'bad_token',
    });
    expect(upsertBoard(db, { ats: 'lever', token: 'x', company: ' ', origin: 'owner' })).toEqual({
      ok: false,
      error: 'bad_company',
    });
    expect(isValidBoardToken('acme-inc.eu')).toBe(true);
    expect(isValidBoardToken('-acme')).toBe(false);
  });

  it('inserts once; a repeat returns the row and can reactivate it', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile([]));
    const first = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'owner', tier: 'A' });
    expect(first).toMatchObject({ ok: true, inserted: true, row: { origin: 'owner', state: 'active', tier: 'A' } });
    if (!first.ok) throw new Error('unreachable');
    setBoardState(db, first.row.id, 'absent');
    const again = upsertBoard(db, {
      ats: 'ashby',
      token: 'hooli',
      company: 'Hooli',
      origin: 'owner',
      reactivate: true,
    });
    expect(again).toMatchObject({ ok: true, inserted: false, row: { state: 'active', tier: 'A' } });
  });

  it('never reactivates a PAUSED board — a pause is the owner block', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile([]));
    const first = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'owner' });
    if (!first.ok) throw new Error('unreachable');
    expect(pauseBoardsForCompany(db, 'Hooli').paused).toBe(1);
    const again = upsertBoard(db, {
      ats: 'ashby',
      token: 'hooli',
      company: 'Hooli',
      origin: 'owner',
      reactivate: true,
    });
    expect(again).toMatchObject({ ok: true, inserted: false, row: { state: 'paused' } });
    expect(listActiveBoards(db)).toEqual([]);
  });
});

describe('block company (§24.201 D4)', () => {
  it('pauses every active board of a company, matched by normalized name', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile(SEED));
    upsertBoard(db, { ats: 'ashby', token: 'acme-eu', company: 'Acme, Inc.', origin: 'owner' });
    expect(findBoardsByCompany(db, 'acme')).toHaveLength(2);

    expect(pauseBoardsForCompany(db, 'ACME Inc')).toEqual({ matched: 2, paused: 2 });
    expect(listActiveBoards(db).map((r) => r.token)).toEqual(['globex', 'initech']);
    // Already paused: still matched (company_blocked stays true), nothing to pause.
    expect(pauseBoardsForCompany(db, 'Acme')).toEqual({ matched: 2, paused: 0 });
    expect(pauseBoardsForCompany(db, 'Nobody Corp')).toEqual({ matched: 0, paused: 0 });
  });
});

describe('recordBoardFetch', () => {
  it('counts failures, resets on success, and retires a board after ats_watchlist_retire_after absent answers', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile(SEED));
    db.prepare(`INSERT INTO preferences (key, value, updated_at) VALUES ('ats_watchlist_retire_after', '3', ?)`).run(
      new Date().toISOString(),
    );
    const acme = listWatchlist(db).find((r) => r.token === 'acme')!;

    expect(recordBoardFetch(db, acme.id, { ok: false, absent: false, error: 'HTTP 503' })).toEqual({
      retired: false,
      consecutive_failures: 1,
      consecutive_absent: 0,
    });
    recordBoardFetch(db, acme.id, { ok: true, absent: false, newLeads: 2 });
    let row = listWatchlist(db).find((r) => r.token === 'acme')!;
    expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, leads_found: 2 });
    expect(row.last_ok_at).toBeTruthy();
    expect(row.last_hit_at).toBeTruthy();

    recordBoardFetch(db, acme.id, { ok: false, absent: true });
    recordBoardFetch(db, acme.id, { ok: false, absent: true });
    expect(recordBoardFetch(db, acme.id, { ok: false, absent: true })).toEqual({
      retired: true,
      consecutive_failures: 3,
      consecutive_absent: 3,
    });
    row = listWatchlist(db).find((r) => r.token === 'acme')!;
    expect(row.state).toBe('absent');
    expect(row.last_error).toMatch(/absent/);
  });

  it('a day of transient failures (5xx, 429, network) never retires a board', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile(SEED));
    // Defaults: retire_after 12 at a 2h cron — 24h. Run well past it.
    const acme = listWatchlist(db).find((r) => r.token === 'acme')!;
    const errors = ['HTTP 503', 'HTTP 429', 'fetch failed: getaddrinfo ENOTFOUND', 'The operation was aborted'];
    for (let i = 0; i < 30; i++) {
      const res = recordBoardFetch(db, acme.id, { ok: false, absent: false, error: errors[i % errors.length] });
      expect(res.retired).toBe(false);
    }
    const row = listWatchlist(db).find((r) => r.token === 'acme')!;
    expect(row).toMatchObject({ state: 'active', consecutive_failures: 30, consecutive_absent: 0 });
    expect(listActiveBoards(db).map((r) => r.token)).toContain('acme');
  });

  it('retires only on a run of absent answers; transient failures between them neither count nor reset it', () => {
    const db = getDb();
    ensureAtsWatchlistSeeded(db, seedFile(SEED));
    db.prepare(`INSERT INTO preferences (key, value, updated_at) VALUES ('ats_watchlist_retire_after', '2', ?)`).run(
      new Date().toISOString(),
    );
    const acme = listWatchlist(db).find((r) => r.token === 'acme')!;
    expect(recordBoardFetch(db, acme.id, { ok: false, absent: true, error: 'HTTP 404' }).retired).toBe(false);
    expect(recordBoardFetch(db, acme.id, { ok: false, absent: false, error: 'HTTP 503' }).retired).toBe(false);
    expect(recordBoardFetch(db, acme.id, { ok: false, absent: true, error: 'HTTP 404' })).toEqual({
      retired: true,
      consecutive_failures: 3,
      consecutive_absent: 2,
    });
  });
});

describe('parseAtsJobUrl', () => {
  it('parses each supported posting URL form to its ATS job identity', () => {
    expect(parseAtsJobUrl('https://job-boards.greenhouse.io/Acme/jobs/123?gh_src=x')).toEqual({
      ats: 'greenhouse',
      token: 'acme',
      job_id: '123',
    });
    expect(parseAtsJobUrl('https://boards.greenhouse.io/acme/jobs/123')).toMatchObject({ job_id: '123' });
    expect(parseAtsJobUrl('https://job-boards.eu.greenhouse.io/acme/jobs/9')).toMatchObject({ token: 'acme' });
    expect(parseAtsJobUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=55')).toEqual({
      ats: 'greenhouse',
      token: 'acme',
      job_id: '55',
    });
    const uuid = '0B6C2F0E-1111-4A8E-9A8F-000000000001';
    expect(parseAtsJobUrl(`https://jobs.lever.co/globex/${uuid}/apply`)).toEqual({
      ats: 'lever',
      token: 'globex',
      job_id: uuid.toLowerCase(),
    });
    expect(parseAtsJobUrl(`https://jobs.ashbyhq.com/hooli/${uuid}/application`)).toEqual({
      ats: 'ashby',
      token: 'hooli',
      job_id: uuid.toLowerCase(),
    });
    expect(atsJobKey('ashby', 'Hooli', uuid)).toBe(`ashby:hooli:${uuid.toLowerCase()}`);
  });

  it('refuses anything else without fetching it', () => {
    for (const u of [
      'https://www.example.com/careers?gh_jid=123',
      'https://job-boards.greenhouse.io/acme',
      'https://evil.example.com/job-boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/globex/not-a-uuid',
      'ftp://jobs.ashbyhq.com/hooli/0b6c2f0e-1111-4a8e-9a8f-000000000001',
      'not a url',
      null,
    ]) {
      expect(parseAtsJobUrl(u)).toBeNull();
    }
  });
});
