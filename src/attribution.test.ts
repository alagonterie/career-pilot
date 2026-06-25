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
  fromPath,
  genCode,
  hashIp,
  MASTER_PDF_SLUG,
  mintLink,
  mintNamedLink,
  pruneVisitTelemetry,
  recordFirstPartyVisit,
  recordVisit,
  refHost,
  resolveLink,
  retireNamedLink,
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
    const h1 = hashIp(ip, 'salt-a');
    expect(h1).toBeTruthy();
    expect(h1).not.toContain(ip);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    // Stable for the same (salt, ip); a different salt yields a different hash.
    expect(hashIp(ip, 'salt-a')).toBe(h1);
    expect(hashIp(ip, 'salt-b')).not.toBe(h1);
    expect(hashIp(null, 'salt-a')).toBeNull();
    expect(hashIp('', 'salt-a')).toBeNull();
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

  it('ensureMasterPdfLink is the ONE fixed, named, transparent source (§24.177 D4)', () => {
    const a = ensureMasterPdfLink();
    const b = ensureMasterPdfLink();
    expect(a).not.toBeNull();
    // Fixed slug (not a random code) + the transparent `?from=` landing path.
    expect(a!.code).toBe(MASTER_PDF_SLUG);
    expect(a!.path).toBe('/?from=master_resume_pdf');
    expect(a!.code).toBe(b!.code);
    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM attribution_link WHERE artifact_type = 'master_pdf'")
      .get() as { n: number };
    expect(count.n).toBe(1);
    // It resolves as a known source (so the landing beacon will record it).
    expect(resolveLink(MASTER_PDF_SLUG)).not.toBeNull();
  });
});

describe('fromPath', () => {
  it('builds the canonical transparent landing path', () => {
    expect(fromPath('my_linkedin')).toBe('/?from=my_linkedin');
    expect(fromPath(MASTER_PDF_SLUG)).toBe('/?from=master_resume_pdf');
  });
});

describe('mintNamedLink + retireNamedLink (§24.177 D5)', () => {
  it('mints an owner_source that resolves with the slug AS the code', () => {
    const out = mintNamedLink('linkedin_profile');
    expect(out).toEqual({ code: 'linkedin_profile' });
    const link = resolveLink('linkedin_profile');
    expect(link!.artifact_type).toBe('owner_source');
    expect(link!.dest_path).toBe('/');
  });

  it('rejects an invalid slug, the reserved master slug, and a collision', () => {
    expect(mintNamedLink('UPPER')).toEqual({ error: 'invalid_slug' });
    expect(mintNamedLink('has space')).toEqual({ error: 'invalid_slug' });
    expect(mintNamedLink('x'.repeat(41))).toEqual({ error: 'invalid_slug' });
    expect(mintNamedLink(MASTER_PDF_SLUG)).toEqual({ error: 'reserved_slug' });
    expect(mintNamedLink('dupe')).toEqual({ code: 'dupe' });
    expect(mintNamedLink('dupe')).toEqual({ error: 'slug_taken' });
  });

  it('retire soft-stops an owner source (keeps the row + history) — not the master/outreach', () => {
    mintNamedLink('conf_talk');
    expect(retireNamedLink('conf_talk')).toEqual({ ok: true });
    // Stops resolving (no NEW attribution) but the row survives.
    expect(resolveLink('conf_talk')).toBeNull();
    expect(getDb().prepare('SELECT 1 FROM attribution_link WHERE code = ?').get('conf_talk')).toBeTruthy();
    // Unknown + non-owner_source links can't be retired here.
    expect(retireNamedLink('nope')).toEqual({ ok: false, error: 'not_found' });
    mintLink({ artifactType: 'outreach', company: 'x.com' });
    expect(retireNamedLink(MASTER_PDF_SLUG)).toEqual({ ok: false, error: 'reserved_slug' });
  });
});

describe('recordFirstPartyVisit (§24.177 D2/D3)', () => {
  it('records a visit only for a KNOWN slug; a spoofed one is ignored', () => {
    mintNamedLink('my_source');
    expect(recordFirstPartyVisit({ slug: 'my_source', ip: '203.0.113.7' })).toEqual({ recorded: true });
    expect(visits()).toHaveLength(1);
    expect(visits()[0].link_code).toBe('my_source');
    // Allow-list: an unknown/spoofed ?from= records nothing.
    expect(recordFirstPartyVisit({ slug: 'totally_made_up', ip: '203.0.113.7' })).toEqual({
      recorded: false,
      reason: 'unknown',
    });
    expect(visits()).toHaveLength(1);
  });

  it('dedups a repeat (slug, ip) inside the window; a new IP or a 0 window records', () => {
    mintNamedLink('src');
    expect(recordFirstPartyVisit({ slug: 'src', ip: '1.1.1.1' }).recorded).toBe(true);
    // Same (slug, ip) within the window → suppressed.
    expect(recordFirstPartyVisit({ slug: 'src', ip: '1.1.1.1' })).toEqual({ recorded: false, reason: 'deduped' });
    expect(visits()).toHaveLength(1);
    // A different IP is a distinct visitor → recorded.
    expect(recordFirstPartyVisit({ slug: 'src', ip: '2.2.2.2' }).recorded).toBe(true);
    expect(visits()).toHaveLength(2);
    // Window disabled (0) → no dedup, even for the same (slug, ip).
    expect(recordFirstPartyVisit({ slug: 'src', ip: '1.1.1.1' }, { dedupWindowSec: 0 }).recorded).toBe(true);
    expect(visits()).toHaveLength(3);
  });

  it('honors the telemetry_capture kill switch', () => {
    mintNamedLink('src');
    getDb()
      .prepare(
        "INSERT INTO preferences (key, value, updated_at) VALUES ('telemetry_capture', 'false', datetime('now'))",
      )
      .run();
    expect(recordFirstPartyVisit({ slug: 'src', ip: '1.1.1.1' })).toEqual({ recorded: false, reason: 'disabled' });
    expect(visits()).toHaveLength(0);
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
