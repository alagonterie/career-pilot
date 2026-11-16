/**
 * Board-lead lifecycle + the watchlist readers (STRATEGY.md §24.200 D6, D7):
 *   - the 14-day stale rule closes only search-sourced leads — a board lead seen
 *     by two `ok` sweeps 15 days apart stays open;
 *   - close-on-absence closes on an `ok` fetch, never a promoted / applied lead,
 *     surfaces a queued one, refuses a suspect empty response, and a reappearing
 *     lead is reopened;
 *   - a tombstoned board posting is not re-inserted by the writer the sweep uses;
 *   - killer-match skips applied / archived / promoted leads;
 *   - `fetch_source` reaches a board that exists only as a table row;
 *   - `discover_ats_board` detects Ashby and adds a verified board as origin owner.
 * No network: `fetch` is stubbed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { ensureAtsWatchlistSeeded, getBoard, upsertBoard } from './ats-watchlist.js';
import {
  applyBoardPresence,
  buildKillerMatchEligibilityClause,
  closeAbsentLeads,
  detectAtsBoard,
  handleCloseStaleLeads,
  handleDiscoverAtsBoard,
  handleFetchSource,
  markLeadsPresent,
  reopenAbsentLeads,
  upsertJobLead,
} from './job-lead-actions.js';
import { writeTombstone } from './lead-guard.js';
import * as payloadCache from './scrape-jobs/payload-cache.js';
import { _clearCache } from './scrape-jobs/sources.js';
import type { JobLeadPayload } from './scrape-jobs/types.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-board-lifecycle-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');
const emptySeed = path.join(tmpDir, 'empty-seed.json');

const SESSION: Session = {
  id: 'test-session-board',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-11-16T00:00:00Z',
};

let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(emptySeed, '[]');
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  // An empty seed: these tests own the watchlist contents.
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

function boardPayload(id: string, over: Partial<JobLeadPayload> = {}): JobLeadPayload {
  return {
    source: 'greenhouse',
    source_board_token: 'acme',
    source_job_id: id,
    source_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    apply_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    title: `Software Engineer ${id}`,
    company: 'Acme',
    location_raw: 'Remote - US',
    description_text: `Distinct description for posting ${id} with enough words to fingerprint.`,
    source_posted_at: new Date().toISOString(),
    ...over,
  };
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

function seedApplication(appId: string): void {
  getDb()
    .prepare(
      `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, created_at)
       VALUES (?, 'Acme', 'fc-test', 'Engineer', 'APPLIED', ?)`,
    )
    .run(appId, new Date().toISOString());
}

const daysAgo = (d: number): Date => new Date(Date.now() - d * 86_400_000);

describe('stale rule is scoped to search-sourced leads (§24.200 D6c)', () => {
  it('a board lead present in two ok sweeps 15 days apart is NOT closed; a stale search lead is', async () => {
    const db = getDb();
    // The board is watched and active — the sweep, not the stale rule, owns its leads.
    upsertBoard(db, { ats: 'greenhouse', token: 'acme', company: 'Acme', origin: 'seed' });
    upsertJobLead(db, boardPayload('g1'));
    upsertJobLead(
      db,
      boardPayload('gj-1', {
        source: 'google_jobs',
        source_board_token: null,
        apply_link_kind: 'company',
        source_url: 'https://careers.example.com/1',
        apply_url: 'https://careers.example.com/1',
      }),
    );
    // Two ok sweeps 15 days apart; the later one leaves last_seen_at past the
    // 14-day threshold, which the old unscoped rule would have closed.
    applyBoardPresence(db, 'greenhouse', 'acme', ['g1'], daysAgo(30));
    applyBoardPresence(db, 'greenhouse', 'acme', ['g1'], daysAgo(15));
    setLead('gj-1', { last_seen_at: daysAgo(20).toISOString() });

    const frame = await call(handleCloseStaleLeads, {});
    expect(frame.ok).toBe(true);
    expect(lead('g1').closed_at).toBeNull();
    expect(lead('gj-1')).toMatchObject({ closed_reason: 'stale' });
  });
});

describe('a board lead whose board is not being swept falls back to the stale rule', () => {
  it('closes stale leads of a paused, retired or unwatched board; never of an active one', async () => {
    const db = getDb();
    for (const [token, state] of [
      ['acme', 'active'],
      ['globex', 'paused'],
      ['initech', 'absent'],
    ] as const) {
      const r = upsertBoard(db, { ats: 'greenhouse', token, company: token, origin: 'seed' });
      if (!r.ok) throw new Error('unreachable');
      db.prepare('UPDATE ats_watchlist SET state = ? WHERE id = ?').run(state, r.row.id);
    }
    for (const token of ['acme', 'globex', 'initech', 'unwatched']) {
      upsertJobLead(db, boardPayload(`${token}-1`, { source_board_token: token, company: token }));
      setLead(`${token}-1`, { last_seen_at: daysAgo(20).toISOString() });
    }
    // A fresh lead of a paused board is not closed yet — only an aged one.
    upsertJobLead(db, boardPayload('globex-fresh', { source_board_token: 'globex', company: 'globex' }));

    const frame = await call(handleCloseStaleLeads, {});
    expect(frame.ok).toBe(true);
    expect(lead('acme-1').closed_at).toBeNull();
    expect(lead('globex-fresh').closed_at).toBeNull();
    for (const id of ['globex-1', 'initech-1', 'unwatched-1']) {
      expect(lead(id)).toMatchObject({ closed_reason: 'stale' });
    }
  });
});

describe('close-on-absence primitives (§24.200 D6c)', () => {
  beforeEach(() => {
    const db = getDb();
    for (const id of ['a', 'b', 'c', 'd', 'e']) upsertJobLead(db, boardPayload(id));
    upsertJobLead(db, boardPayload('other-board', { source_board_token: 'globex', company: 'Globex' }));
  });

  it('closes leads missing from an ok fetch as absent — but not promoted, applied or queued ones', () => {
    const db = getDb();
    seedApplication('app-1');
    setLead('b', { application_id: 'app-1', status: 'applied' });
    setLead('c', { status: 'applied' });
    setLead('d', { status: 'queued' });

    const res = closeAbsentLeads(db, 'greenhouse', 'acme', ['a']);
    expect(res.suspect).toBe(false);
    expect(res.closed).toEqual([lead('e').id]);
    expect(res.queued).toEqual([{ id: lead('d').id, title: 'Software Engineer d', company: 'Acme' }]);
    expect(lead('e')).toMatchObject({ closed_reason: 'absent' });
    for (const id of ['a', 'b', 'c', 'd']) expect(lead(id).closed_at).toBeNull();
    expect(lead('other-board').closed_at).toBeNull(); // another board is never touched
  });

  it('an ok fetch returning zero postings for a board with open leads is suspect and closes nothing', () => {
    const res = closeAbsentLeads(getDb(), 'greenhouse', 'acme', []);
    expect(res).toEqual({ closed: [], queued: [], suspect: true });
    expect(lead('a').closed_at).toBeNull();
  });

  it('a lead closed as absent that reappears is reopened; other closures are not', () => {
    const db = getDb();
    closeAbsentLeads(db, 'greenhouse', 'acme', ['a', 'b', 'c']); // closes d, e
    setLead('d', { closed_reason: 'not_interested:role', status: 'archived' });

    const reopened = reopenAbsentLeads(db, 'greenhouse', ['d', 'e']);
    expect(reopened).toEqual([lead('e').id]);
    expect(lead('e')).toMatchObject({ closed_at: null, closed_reason: null });
    expect(lead('d')).toMatchObject({ closed_reason: 'not_interested:role' });
  });

  it('markLeadsPresent stamps last_seen_at only on open leads that are present', () => {
    const db = getDb();
    const old = daysAgo(10).toISOString();
    for (const id of ['a', 'b', 'c']) setLead(id, { last_seen_at: old });
    setLead('c', { closed_at: old, closed_reason: 'manual' });
    const now = new Date();
    expect(markLeadsPresent(db, 'greenhouse', ['a', 'c', 'zzz'], now)).toBe(1);
    expect(lead('a').last_seen_at).toBe(now.toISOString());
    expect(lead('b').last_seen_at).toBe(old);
    expect(lead('c').last_seen_at).toBe(old);
  });

  it('applyBoardPresence reopens, refreshes and closes in one pass', () => {
    const db = getDb();
    closeAbsentLeads(db, 'greenhouse', 'acme', ['a', 'b', 'c', 'd']); // closes e
    const res = applyBoardPresence(db, 'greenhouse', 'acme', ['a', 'b', 'c', 'e']); // d gone, e back
    expect(res.reopened).toEqual([lead('e').id]);
    expect(res.closed).toEqual([lead('d').id]);
    expect(res.refreshed).toBe(4);
  });
});

describe('the writer the sweep uses honours tombstones', () => {
  it('a tombstoned board posting is not re-inserted', () => {
    const db = getDb();
    writeTombstone(db, {
      source: 'greenhouse',
      source_job_id: 'gone-1',
      content_fingerprint: null,
      company: 'Acme',
      title: 'Software Engineer gone-1',
      reason: 'deleted',
      match: 'id',
    });
    const res = upsertJobLead(db, boardPayload('gone-1'));
    expect(res.recorded).toBe(false);
    expect(lead('gone-1')).toBeUndefined();
  });
});

describe('killer-match eligibility (§24.200 D6e)', () => {
  it('excludes leads that are applied, archived or linked to an application', () => {
    const db = getDb();
    for (const id of ['ok', 'applied', 'archived', 'linked']) {
      upsertJobLead(db, boardPayload(id));
      setLead(id, { rules_score: 99 });
    }
    seedApplication('app-2');
    setLead('applied', { status: 'applied' });
    setLead('archived', { status: 'archived' });
    setLead('linked', { application_id: 'app-2' });
    const { whereSql, params } = buildKillerMatchEligibilityClause(
      { minRulesScore: 90, recencyWindowHours: 6, sourceAllowList: ['greenhouse'], maxPerFire: 3 },
      new Date(),
    );
    const ids = (
      db.prepare(`SELECT source_job_id FROM job_leads WHERE ${whereSql}`).all(params) as Array<{
        source_job_id: string;
      }>
    ).map((r) => r.source_job_id);
    expect(ids).toEqual(['ok']);
  });

  it('a board posting published 3h ago with a -05:00 offset is eligible inside a 6h window', () => {
    const db = getDb();
    const now = new Date();
    // The same instant written the way Greenhouse writes it: local time + offset.
    const posted = new Date(Math.floor((now.getTime() - 3 * 3_600_000) / 1000) * 1000);
    const local = new Date(posted.getTime() - 5 * 3_600_000).toISOString().slice(0, 19) + '-05:00';
    expect(Date.parse(local)).toBe(posted.getTime());
    upsertJobLead(db, boardPayload('tz', { source_posted_at: local }));
    setLead('tz', { rules_score: 99 });
    expect(lead('tz').source_posted_at).toBe(posted.toISOString());
    const { whereSql, params } = buildKillerMatchEligibilityClause(
      { minRulesScore: 90, recencyWindowHours: 6, sourceAllowList: ['greenhouse'], maxPerFire: 3 },
      now,
    );
    const ids = (
      db.prepare(`SELECT source_job_id FROM job_leads WHERE ${whereSql}`).all(params) as Array<{
        source_job_id: string;
      }>
    ).map((r) => r.source_job_id);
    expect(ids).toEqual(['tz']);
  });
});

describe('fetch_source reads the watchlist table (§24.200 D7)', () => {
  it('reaches a board that exists only as a table row (no seed-file entry), and skips a paused one', async () => {
    const db = getDb();
    upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'owner', tier: 'A' });
    const paused = upsertBoard(db, { ats: 'lever', token: 'globex', company: 'Globex', origin: 'owner', tier: 'A' });
    if (!paused.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(paused.row.id);

    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain('api.ashbyhq.com/posting-api/job-board/hooli');
      return new Response(
        JSON.stringify({
          jobs: [
            {
              id: 'h-1',
              title: 'Backend Engineer',
              workplaceType: 'Remote',
              location: 'Remote',
              isListed: true,
              jobUrl: 'https://jobs.ashbyhq.com/hooli/h-1',
              publishedAt: '2026-11-15T00:00:00Z',
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchFn);

    const frame = await call(handleFetchSource, { priority: 'A' });
    expect(frame.ok).toBe(true);
    if (!frame.ok) throw new Error('unreachable');
    expect(frame.data.boards_scanned).toBe(1);
    expect(frame.data.summaries).toEqual([
      expect.objectContaining({ source: 'ashby', source_job_id: 'h-1', company: 'Hooli', apply_link_kind: 'ats' }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(payloadCache.get('ashby', 'h-1')).toBeTruthy();
  });
});

describe('discover_ats_board (§24.200 D7)', () => {
  it('detects every supported board reference form', () => {
    expect(detectAtsBoard('<a href="https://jobs.ashbyhq.com/hooli">Jobs</a>')).toEqual({
      ats: 'ashby',
      token: 'hooli',
    });
    expect(detectAtsBoard('<script src="https://jobs.ashbyhq.com/hooli/embed?version=2">')).toEqual({
      ats: 'ashby',
      token: 'hooli',
    });
    expect(detectAtsBoard('https://boards.greenhouse.io/embed/job_board/js?for=acme')).toEqual({
      ats: 'greenhouse',
      token: 'acme',
    });
    expect(detectAtsBoard('https://job-boards.greenhouse.io/acme/jobs/1')).toEqual({
      ats: 'greenhouse',
      token: 'acme',
    });
    expect(detectAtsBoard('https://jobs.lever.co/globex/abc')).toEqual({ ats: 'lever', token: 'globex' });
    expect(detectAtsBoard('<p>no board here</p>')).toBeNull();
  });

  it('parses an Ashby board link, verifies it through the API host only, and adds it as origin owner', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain('api.ashbyhq.com/posting-api/job-board/hooli');
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchFn);

    const frame = await call(handleDiscoverAtsBoard, {
      careers_url: 'https://jobs.ashbyhq.com/hooli',
      company: 'Hooli',
      tier: 'A',
    });
    expect(frame).toMatchObject({
      ok: true,
      data: { ats: 'ashby', token: 'hooli', verified: true, added: true, company: 'Hooli', tier: 'A' },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(getBoard(getDb(), 'ashby', 'hooli')).toMatchObject({ origin: 'owner', state: 'active', company: 'Hooli' });
  });

  it('never fetches a supplied URL: a careers page, a loopback or a private address is refused unfetched', async () => {
    const fetchFn = vi.fn(async () => new Response('<a href="https://jobs.ashbyhq.com/hooli">x</a>', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    for (const careers_url of [
      'https://www.example.com/careers',
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/?next=https://jobs.ashbyhq.com/hooli',
    ]) {
      const frame = await call(handleDiscoverAtsBoard, { careers_url });
      expect(frame).toMatchObject({ ok: true, data: { ats: null, added: false, reason: 'not_a_board_link' } });
      if (frame.ok) expect(frame.data).not.toHaveProperty('http_status');
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(getBoard(getDb(), 'ashby', 'hooli')).toBeUndefined();
  });

  it('an agent re-add never lifts an owner block; a retired board that answers again is reactivated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })),
    );
    const db = getDb();
    const blocked = upsertBoard(db, { ats: 'ashby', token: 'hooli', company: 'Hooli', origin: 'seed' });
    const retired = upsertBoard(db, { ats: 'ashby', token: 'initech', company: 'Initech', origin: 'seed' });
    if (!blocked.ok || !retired.ok) throw new Error('unreachable');
    db.prepare("UPDATE ats_watchlist SET state = 'paused' WHERE id = ?").run(blocked.row.id);
    db.prepare("UPDATE ats_watchlist SET state = 'absent' WHERE id = ?").run(retired.row.id);

    const b = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.ashbyhq.com/hooli', company: 'Hooli' });
    expect(b).toMatchObject({
      ok: true,
      data: { already_listed: true, state: 'paused', blocked_by_owner: true },
    });
    expect(getBoard(db, 'ashby', 'hooli')?.state).toBe('paused');

    const r = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.ashbyhq.com/initech' });
    expect(r).toMatchObject({ ok: true, data: { already_listed: true, state: 'active' } });
    if (r.ok) expect(r.data).not.toHaveProperty('blocked_by_owner');
  });

  it('a board link that does not verify is reported but not added', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 })),
    );
    const frame = await call(handleDiscoverAtsBoard, { careers_url: 'https://jobs.lever.co/ghostco' });
    expect(frame).toMatchObject({
      ok: true,
      data: { ats: 'lever', token: 'ghostco', verified: false, added: false, reason: 'board_absent' },
    });
    expect(getBoard(getDb(), 'lever', 'ghostco')).toBeUndefined();
  });
});
