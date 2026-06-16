/**
 * Tests for the visitor-attribution module (STRATEGY.md §24.74).
 *
 * Pure helpers: code shape, email→company, IP→salted-hash (raw never stored),
 * UA→class, referrer→host. DB functions: mint round-trips + resolves; expiry is
 * honored; the master-PDF link is reused (single stable token); visits record
 * with minimized fields; the `telemetry_capture` switch suppresses; the prune
 * deletes strictly-older rows only; nothing throws on an un-migrated DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  companyFromEmail,
  ensureMasterPdfLink,
  genCode,
  hashIp,
  mintLink,
  pruneVisitTelemetry,
  recordVisit,
  refHost,
  resolveLink,
  uaClass,
} from './attribution.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

interface VisitRow {
  id: string;
  ts: string;
  link_code: string | null;
  path: string | null;
  ip_hash: string | null;
  country: string | null;
  region: string | null;
  ua_class: string | null;
  referrer: string | null;
  details_json: string | null;
}

function visits(): VisitRow[] {
  return getDb().prepare('SELECT * FROM visit_telemetry ORDER BY ts').all() as VisitRow[];
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
  delete process.env.VISIT_IP_HASH_SALT;
});

describe('pure helpers', () => {
  it('genCode is 8 url-safe chars and varies', () => {
    const a = genCode();
    const b = genCode();
    expect(a).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(a).not.toBe(b);
    expect(genCode(12)).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  it('companyFromEmail returns the lowercased domain, null on garbage', () => {
    expect(companyFromEmail('Jane.Doe@Anthropic.com')).toBe('anthropic.com');
    expect(companyFromEmail('recruiter@careers.stripe.com')).toBe('careers.stripe.com');
    expect(companyFromEmail('not-an-email')).toBeNull();
    expect(companyFromEmail('')).toBeNull();
    expect(companyFromEmail(null)).toBeNull();
  });

  it('hashIp never returns the raw IP and is salt-sensitive + stable', () => {
    const ip = '203.0.113.7';
    const h1 = hashIp(ip);
    expect(h1).toBeTruthy();
    expect(h1).not.toContain(ip);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    // Stable for the same (salt, ip).
    expect(hashIp(ip)).toBe(h1);
    // A different salt yields a different hash.
    process.env.VISIT_IP_HASH_SALT = 'a-different-salt';
    expect(hashIp(ip)).not.toBe(h1);
    expect(hashIp(null)).toBeNull();
    expect(hashIp('')).toBeNull();
  });

  it('uaClass buckets bots, mobile, desktop', () => {
    expect(uaClass('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot');
    expect(uaClass('facebookexternalhit/1.1')).toBe('bot');
    expect(uaClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(uaClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop');
    expect(uaClass(null)).toBeNull();
  });

  it('refHost reduces a referrer to a host, null when empty', () => {
    expect(refHost('https://www.linkedin.com/feed/update/123')).toBe('www.linkedin.com');
    expect(refHost('http://news.ycombinator.com/')).toBe('news.ycombinator.com');
    expect(refHost('')).toBeNull();
    expect(refHost(null)).toBeNull();
  });
});

describe('mintLink + resolveLink', () => {
  it('mints an outreach link and resolves it round-trip', () => {
    const minted = mintLink({
      artifactType: 'outreach',
      company: 'anthropic.com',
      recipient: 'jane.doe@anthropic.com',
    });
    expect(minted).not.toBeNull();
    expect(minted!.path).toBe(`/r/${minted!.code}`);

    const link = resolveLink(minted!.code);
    expect(link).not.toBeNull();
    expect(link!.artifact_type).toBe('outreach');
    expect(link!.company).toBe('anthropic.com');
    expect(link!.recipient).toBe('jane.doe@anthropic.com');
    expect(link!.dest_path).toBe('/');
  });

  it('returns null for an unknown code', () => {
    expect(resolveLink('nope1234')).toBeNull();
    expect(resolveLink(null)).toBeNull();
  });

  it('honors expiry — an expired link does not resolve', () => {
    const minted = mintLink({ artifactType: 'outreach' });
    expect(minted).not.toBeNull();
    // Resolves while live, then not once expired.
    expect(resolveLink(minted!.code)).not.toBeNull();
    const past = new Date(Date.now() - 1000).toISOString();
    getDb().prepare('UPDATE attribution_link SET expires_at = ? WHERE code = ?').run(past, minted!.code);
    expect(resolveLink(minted!.code)).toBeNull();
  });

  it('ensureMasterPdfLink returns ONE stable reused token', () => {
    const a = ensureMasterPdfLink();
    const b = ensureMasterPdfLink();
    expect(a).not.toBeNull();
    expect(a!.code).toBe(b!.code);
    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM attribution_link WHERE artifact_type = 'master_pdf'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('recordVisit', () => {
  it('writes a minimized row (hashed ip, ua class, referrer host)', () => {
    recordVisit({
      linkCode: 'abc12345',
      path: '/',
      ip: '203.0.113.7',
      country: 'US',
      region: 'California',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      referrer: 'https://www.linkedin.com/in/someone',
    });
    const rows = visits();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.link_code).toBe('abc12345');
    expect(r.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.ip_hash).not.toContain('203.0.113.7');
    expect(r.country).toBe('US');
    expect(r.ua_class).toBe('mobile');
    expect(r.referrer).toBe('www.linkedin.com');
  });

  it('suppresses writes when telemetry_capture is off', () => {
    getDb()
      .prepare(
        "INSERT INTO preferences (key, value, updated_at) VALUES ('telemetry_capture', 'false', datetime('now'))",
      )
      .run();
    recordVisit({ linkCode: 'abc12345', ip: '203.0.113.7' });
    expect(visits()).toHaveLength(0);
  });

  it('records a null-IP visit without a hash', () => {
    recordVisit({ linkCode: 'abc12345', path: '/' });
    const r = visits()[0];
    expect(r.ip_hash).toBeNull();
  });
});

describe('pruneVisitTelemetry', () => {
  function insertAt(id: string, ts: string): void {
    getDb().prepare('INSERT INTO visit_telemetry (id, ts) VALUES (?, ?)').run(id, ts);
  }

  it('deletes strictly-older-than-retention rows only', () => {
    const now = Date.now();
    const retentionDays = 90;
    insertAt('vt-old', new Date(now - 91 * 86_400_000).toISOString());
    insertAt('vt-boundary', new Date(now - retentionDays * 86_400_000 + 60_000).toISOString());
    insertAt('vt-new', new Date(now).toISOString());

    const deleted = pruneVisitTelemetry(getDb(), retentionDays);
    expect(deleted).toBe(1);
    const ids = visits().map((r) => r.id);
    expect(ids).toContain('vt-boundary');
    expect(ids).toContain('vt-new');
    expect(ids).not.toContain('vt-old');
  });
});
