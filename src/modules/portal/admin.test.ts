/**
 * Tests for the owner-only /admin surface (STRATEGY §24.74 D5).
 *
 * `adminEnabled`: open on the dev stack, fail-closed otherwise (default config).
 * `buildAttributionReport`: aggregates clicks + unique visitors per link, the
 * by-artifact + top-country summary, and the recent-visit feed; empty on a bare
 * DB; nothing leaks beyond the two private tables.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { adminEnabled, buildAttributionReport } from './admin.js';

function seedLink(code: string, artifact: string, company: string | null, recipient: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO attribution_link (code, artifact_type, company, recipient, dest_path, created_at)
       VALUES (?, ?, ?, ?, '/', ?)`,
    )
    .run(code, artifact, company, recipient, new Date().toISOString());
}

function seedVisit(id: string, code: string | null, ipHash: string | null, country: string | null, ts: string): void {
  getDb()
    .prepare(
      `INSERT INTO visit_telemetry (id, ts, link_code, path, ip_hash, country, ua_class, referrer)
       VALUES (?, ?, ?, '/', ?, ?, 'desktop', NULL)`,
    )
    .run(id, ts, code, ipHash, country);
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
  delete process.env.ENVIRONMENT;
});

describe('adminEnabled', () => {
  it('is open on the dev stack', () => {
    process.env.ENVIRONMENT = 'dev';
    expect(adminEnabled()).toBe(true);
  });

  it('fails closed on a non-dev stack by default', () => {
    process.env.ENVIRONMENT = 'production';
    expect(adminEnabled()).toBe(false);
  });
});

describe('buildAttributionReport', () => {
  it('returns an empty report on a bare DB (no rows)', () => {
    const r = buildAttributionReport(getDb());
    expect(r.links).toHaveLength(0);
    expect(r.recentVisits).toHaveLength(0);
    expect(r.summary.totalClicks).toBe(0);
  });

  it('aggregates clicks + unique visitors per link with a summary + recent feed', () => {
    seedLink('out1', 'outreach', 'anthropic.com', 'jane@anthropic.com');
    seedLink('mp1', 'master_pdf', null, null);
    // out1: 3 clicks from 2 distinct IPs; mp1: 1 click.
    seedVisit('v1', 'out1', 'iphashA', 'US', '2026-06-16T10:00:00.000Z');
    seedVisit('v2', 'out1', 'iphashA', 'US', '2026-06-16T11:00:00.000Z');
    seedVisit('v3', 'out1', 'iphashB', 'CA', '2026-06-16T12:00:00.000Z');
    seedVisit('v4', 'mp1', 'iphashC', 'US', '2026-06-16T13:00:00.000Z');

    const r = buildAttributionReport(getDb());

    expect(r.links).toHaveLength(2);
    const out1 = r.links.find((l) => l.code === 'out1')!;
    expect(out1.clicks).toBe(3);
    expect(out1.uniqueVisitors).toBe(2);
    expect(out1.company).toBe('anthropic.com');
    expect(out1.recipient).toBe('jane@anthropic.com');
    expect(out1.lastClickAt).toBe('2026-06-16T12:00:00.000Z');
    const mp1 = r.links.find((l) => l.code === 'mp1')!;
    expect(mp1.clicks).toBe(1);

    expect(r.summary.totalLinks).toBe(2);
    expect(r.summary.totalClicks).toBe(4);
    expect(r.summary.totalUniqueVisitors).toBe(3);
    expect(r.summary.byArtifact).toEqual({ outreach: 1, master_pdf: 1 });
    expect(r.summary.topCountries[0]).toEqual({ country: 'US', clicks: 3 });

    // Recent feed: newest first, joined company carried through.
    expect(r.recentVisits).toHaveLength(4);
    expect(r.recentVisits[0].ts).toBe('2026-06-16T13:00:00.000Z');
    expect(r.recentVisits[r.recentVisits.length - 1].ts).toBe('2026-06-16T10:00:00.000Z');
    expect(r.recentVisits.find((v) => v.linkCode === 'out1')!.company).toBe('anthropic.com');
  });

  it('honors the recentLimit', () => {
    seedLink('out1', 'outreach', 'x.com', null);
    for (let i = 0; i < 5; i++) seedVisit(`v${i}`, 'out1', `ip${i}`, 'US', `2026-06-16T1${i}:00:00.000Z`);
    expect(buildAttributionReport(getDb(), { recentLimit: 2 }).recentVisits).toHaveLength(2);
  });
});
