/**
 * src/attribution.ts — visitor-attribution links + first-party visit telemetry
 * (STRATEGY.md §24.74).
 *
 * Opaque `/r/<code>` short links are minted automatically + host-side at
 * outbound-artifact composition (the outreach-email footer; the master résumé
 * PDF footer — §24.74 D2). Resolving a code records one click and 302s to the
 * link's `dest_path`. Top-level (not a module) because the choke points span the
 * career-pilot module (outreach) and the portal module (the PDF render + the
 * `/r/*` resolver) — the same rationale as `request-telemetry.ts`.
 *
 * Contracts (§24.74 D4):
 *   - `recordVisit` NEVER throws into the calling path; honors `telemetry_capture`.
 *   - The IP is stored only as a SALTED HASH (repeat-visit detection without the
 *     raw address); geo is coarse; the UA is reduced to a class; the referrer to
 *     a host. Owner-private — surfaced only on the Access-gated `/admin`.
 *   - `mintLink` is best-effort: a failure returns null so the caller falls back
 *     to the un-tokenized URL rather than breaking the artifact.
 */
import crypto from 'node:crypto';

import type Database from 'better-sqlite3';

import { getDb, hasTable } from './db/connection.js';
import { readEnvFile } from './env.js';
import { getConfig } from './get-config.js';
import { log } from './log.js';

export type ArtifactType = 'outreach' | 'master_pdf' | 'owner_source';

/**
 * A named visit-source slug (§24.177): the transparent `?from=<slug>` token an
 * owner mints from the Visitors tab. Lowercase/digits/underscore, ≤40 chars — it
 * IS the `attribution_link.code`, and it lands a visitor in a URL bar, so it
 * stays human-legible (the whole point) and safe to drop into a `Location`/query.
 */
export const VISIT_SLUG_RE = /^[a-z0-9_]{1,40}$/;

/** The single fixed source for the master-résumé download (§24.177 D4). */
export const MASTER_PDF_SLUG = 'master_resume_pdf';

/** The canonical transparent landing path for a named source (§24.177 D1). */
export function fromPath(slug: string): string {
  return `/?from=${encodeURIComponent(slug)}`;
}

export interface AttributionLink {
  code: string;
  artifact_type: string;
  company: string | null;
  recipient: string | null;
  application_id: string | null;
  dest_path: string;
  created_at: string;
  expires_at: string | null;
}

export interface MintLinkInput {
  artifactType: ArtifactType;
  /** Attribution key — for outreach, the recipient's email domain. */
  company?: string | null;
  /** Owner-private; the outreach recipient address (NULL for master_pdf). */
  recipient?: string | null;
  applicationId?: string | null;
  /** Where `/r/<code>` 302s to. Always '/' per §24.74 D1; overridable for tests. */
  destPath?: string;
  /** Optional expiry in days from now; omit for no expiry. */
  ttlDays?: number;
}

export interface RecordVisitInput {
  linkCode?: string | null;
  path?: string | null;
  /** Raw client IP — hashed here, never stored raw. */
  ip?: string | null;
  country?: string | null;
  region?: string | null;
  userAgent?: string | null;
  /** Raw Referer header — reduced to a host here. */
  referrer?: string | null;
  details?: Record<string, unknown> | null;
}

// base62, ambiguity-tolerant (it's opaque, not typed by humans).
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LEN = 8;
const REFERRER_CAP = 120;
const COMPANY_CAP = 120;

// The IP-hash salt (§24.74 D4), resolved once at load. Read from .env via
// readEnvFile — kept OUT of process.env like every other host secret (src/env.ts)
// — with a process.env secondary (for contexts that do export it) and a constant
// fallback so we never store a raw IP even when the salt is unset (dev/test).
const IP_HASH_SALT =
  readEnvFile(['VISIT_IP_HASH_SALT']).VISIT_IP_HASH_SALT ?? process.env.VISIT_IP_HASH_SALT ?? 'career-pilot-visit';

/** A short opaque code for `/r/<code>` (crypto-random; collision-checked on insert). */
export function genCode(len = CODE_LEN): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** The lowercased email domain — the deterministic company key for outreach. */
export function companyFromEmail(to: string | null | undefined): string | null {
  if (!to || typeof to !== 'string') return null;
  const at = to.lastIndexOf('@');
  if (at < 0) return null;
  const domain = to
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain ? domain.slice(0, COMPANY_CAP) : null;
}

/**
 * A SALTED hash of the IP — the only form we persist (§24.74 D4). The salt
 * defaults to the load-time `IP_HASH_SALT` (the `VISIT_IP_HASH_SALT` secret from
 * .env, else a constant); callers can pass an explicit salt (tests). When the
 * secret is unset we still hash, so we never store a raw IP. Truncated — we only
 * need enough to tell a repeat visit from a new one.
 */
export function hashIp(ip: string | null | undefined, salt: string = IP_HASH_SALT): string | null {
  if (!ip || typeof ip !== 'string' || !ip.trim()) return null;
  return crypto.createHash('sha256').update(`${salt}:${ip.trim()}`).digest('hex').slice(0, 16);
}

/** Reduce a User-Agent to a coarse class — never the full string (§24.74 D4). */
export function uaClass(ua: string | null | undefined): string | null {
  if (!ua || typeof ua !== 'string') return null;
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|preview|monitor/i.test(ua)) return 'bot';
  if (/mobile|android|iphone|ipad|ipod|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** The referrer HOST only (not the full URL) — capped. NULL when unparseable/empty. */
export function refHost(referrer: string | null | undefined): string | null {
  if (!referrer || typeof referrer !== 'string' || !referrer.trim()) return null;
  try {
    return new URL(referrer.trim()).host.slice(0, REFERRER_CAP) || null;
  } catch {
    return (
      referrer
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .slice(0, REFERRER_CAP) || null
    );
  }
}

/**
 * Mint one attribution link. Best-effort: returns the `{ code, path }` on
 * success, or null on any failure (un-migrated DB, repeated collisions, closed
 * handle) so the caller emits the un-tokenized URL rather than breaking.
 */
export function mintLink(input: MintLinkInput): { code: string; path: string } | null {
  try {
    const db = getDb();
    if (!hasTable(db, 'attribution_link')) return null;
    const destPath = input.destPath ?? '/';
    const createdAt = new Date().toISOString();
    const expiresAt =
      typeof input.ttlDays === 'number' && input.ttlDays > 0
        ? new Date(Date.now() + input.ttlDays * 86_400_000).toISOString()
        : null;
    const stmt = db.prepare(
      `INSERT INTO attribution_link
         (code, artifact_type, company, recipient, application_id, dest_path, created_at, expires_at)
       VALUES (@code, @artifact_type, @company, @recipient, @application_id, @dest_path, @created_at, @expires_at)`,
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = genCode();
      try {
        stmt.run({
          code,
          artifact_type: input.artifactType,
          company: input.company ? String(input.company).slice(0, COMPANY_CAP) : null,
          recipient: input.recipient ?? null,
          application_id: input.applicationId ?? null,
          dest_path: destPath,
          created_at: createdAt,
          expires_at: expiresAt,
        });
        return { code, path: `/r/${code}` };
      } catch (err) {
        // Retry only on a primary-key collision; rethrow anything else to the outer catch.
        if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) continue;
        throw err;
      }
    }
    log.warn('attribution: mintLink exhausted code retries', { artifactType: input.artifactType });
    return null;
  } catch (err) {
    log.warn('attribution: mintLink failed', { artifactType: input.artifactType, err });
    return null;
  }
}

/**
 * The single fixed token for the master-résumé PDF footer (§24.177 D4). The
 * master download now attributes through the NAMED, transparent source
 * `master_resume_pdf` (`?from=master_resume_pdf`) instead of an opaque `/r/<code>`
 * — so the link in a forwarded résumé is self-describing. Idempotent
 * (INSERT-OR-IGNORE on the fixed code); returns the `?from=` landing path.
 * (Already-distributed PDFs carrying an old random `/r/` code still resolve.)
 */
export function ensureMasterPdfLink(): { code: string; path: string } | null {
  try {
    const db = getDb();
    if (!hasTable(db, 'attribution_link')) return null;
    db.prepare(
      `INSERT OR IGNORE INTO attribution_link
         (code, artifact_type, company, recipient, application_id, dest_path, created_at, expires_at)
       VALUES (?, 'master_pdf', NULL, NULL, NULL, '/', ?, NULL)`,
    ).run(MASTER_PDF_SLUG, new Date().toISOString());
    return { code: MASTER_PDF_SLUG, path: fromPath(MASTER_PDF_SLUG) };
  } catch (err) {
    log.warn('attribution: ensureMasterPdfLink failed', { err });
    return null;
  }
}

/**
 * Mint an owner-named visit source (§24.177 D5) — the Visitors-tab "new source"
 * write. Validates the slug, rejects the reserved master slug + any collision,
 * then inserts an `owner_source` row reusable as both a `?from=<slug>` link and a
 * handed-out résumé PDF. Never throws.
 */
export function mintNamedLink(slug: string): { code: string } | { error: string } {
  if (typeof slug !== 'string' || !VISIT_SLUG_RE.test(slug)) return { error: 'invalid_slug' };
  if (slug === MASTER_PDF_SLUG) return { error: 'reserved_slug' };
  try {
    const db = getDb();
    if (!hasTable(db, 'attribution_link')) return { error: 'unavailable' };
    if (db.prepare('SELECT 1 FROM attribution_link WHERE code = ?').get(slug)) return { error: 'slug_taken' };
    db.prepare(
      `INSERT INTO attribution_link
         (code, artifact_type, company, recipient, application_id, dest_path, created_at, expires_at)
       VALUES (?, 'owner_source', NULL, NULL, NULL, '/', ?, NULL)`,
    ).run(slug, new Date().toISOString());
    return { code: slug };
  } catch (err) {
    log.warn('attribution: mintNamedLink failed', { slug, err });
    return { error: 'mint_failed' };
  }
}

/**
 * Retire an owner-named source (§24.177 D5) — a soft stop: set `expires_at=now`
 * so it stops attributing NEW visits but keeps the row + its historical clicks.
 * Owner-sources only (never the auto-minted master/outreach links). Never throws.
 */
export function retireNamedLink(slug: string): { ok: boolean; error?: string } {
  if (typeof slug !== 'string' || !VISIT_SLUG_RE.test(slug)) return { ok: false, error: 'invalid_slug' };
  if (slug === MASTER_PDF_SLUG) return { ok: false, error: 'reserved_slug' };
  try {
    const db = getDb();
    if (!hasTable(db, 'attribution_link')) return { ok: false, error: 'unavailable' };
    const res = db
      .prepare("UPDATE attribution_link SET expires_at = ? WHERE code = ? AND artifact_type = 'owner_source'")
      .run(new Date().toISOString(), slug);
    return res.changes > 0 ? { ok: true } : { ok: false, error: 'not_found' };
  } catch (err) {
    log.warn('attribution: retireNamedLink failed', { slug, err });
    return { ok: false, error: 'retire_failed' };
  }
}

/** Resolve a code to its (non-expired) link, or null. */
export function resolveLink(code: string | null | undefined): AttributionLink | null {
  if (!code || typeof code !== 'string') return null;
  try {
    const db = getDb();
    if (!hasTable(db, 'attribution_link')) return null;
    const row = db
      .prepare(
        `SELECT code, artifact_type, company, recipient, application_id, dest_path, created_at, expires_at
         FROM attribution_link
         WHERE code = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(code, new Date().toISOString()) as AttributionLink | undefined;
    return row ?? null;
  } catch (err) {
    log.warn('attribution: resolveLink failed', { err });
    return null;
  }
}

/**
 * Record one visit. Best-effort (never throws); honors the `telemetry_capture`
 * kill switch. The IP/UA/referrer are minimized here, never stored raw.
 */
export function recordVisit(input: RecordVisitInput): void {
  try {
    const db = getDb();
    if (!getConfig<boolean>(db, 'telemetry_capture', true)) return;
    if (!hasTable(db, 'visit_telemetry')) return;

    db.prepare(
      `INSERT INTO visit_telemetry
         (id, ts, link_code, path, ip_hash, country, region, ua_class, referrer, details_json)
       VALUES (@id, @ts, @link_code, @path, @ip_hash, @country, @region, @ua_class, @referrer, @details_json)`,
    ).run({
      id: `vt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      link_code: input.linkCode ?? null,
      path: input.path ?? null,
      ip_hash: hashIp(input.ip),
      country: input.country ? String(input.country).slice(0, 8) : null,
      region: input.region ? String(input.region).slice(0, 64) : null,
      ua_class: uaClass(input.userAgent),
      referrer: refHost(input.referrer),
      details_json: input.details ? JSON.stringify(input.details) : null,
    });
  } catch (err) {
    log.warn('attribution: recordVisit failed', { linkCode: input.linkCode, err });
  }
}

/**
 * Record one FIRST-PARTY visit from the landing-page beacon (§24.177 D2/D3).
 * Unlike the `/r/<code>` redirect, the slug arrives in the URL bar, so this is
 * the spam-facing path — it is hardened two ways:
 *   - ALLOW-LIST: record only when `slug` resolves to a known, non-expired
 *     attribution_link. A spoofed `?from=anything` resolves to nothing → ignored
 *     (treated as a direct visit, no row, no injectable sources).
 *   - WINDOWED WRITE-DEDUP per (slug, ip_hash): suppress a repeat row inside the
 *     `visit_beacon_dedup_window_sec` window. THE load-bearing guard — collapses
 *     refresh-spam OR scripted endpoint-hammering to one row per window (a client
 *     guard is bypassable by curling the endpoint directly). No spend is at stake;
 *     this just keeps the click counts honest + storage bounded.
 * Best-effort, never throws; honors `telemetry_capture`.
 */
export function recordFirstPartyVisit(
  input: {
    slug?: string | null;
    ip?: string | null;
    country?: string | null;
    userAgent?: string | null;
    referrer?: string | null;
  },
  opts: { dedupWindowSec?: number } = {},
): { recorded: boolean; reason?: 'unknown' | 'deduped' | 'disabled' | 'error' } {
  try {
    const db = getDb();
    if (!getConfig<boolean>(db, 'telemetry_capture', true)) return { recorded: false, reason: 'disabled' };
    const link = resolveLink(input.slug);
    if (!link) return { recorded: false, reason: 'unknown' };

    const windowSec = opts.dedupWindowSec ?? getConfig<number>(db, 'visit_beacon_dedup_window_sec', 1800);
    const ipHash = hashIp(input.ip);
    if (ipHash && windowSec > 0 && hasTable(db, 'visit_telemetry')) {
      const since = new Date(Date.now() - windowSec * 1000).toISOString();
      const dup = db
        .prepare('SELECT 1 FROM visit_telemetry WHERE link_code = ? AND ip_hash = ? AND ts >= ? LIMIT 1')
        .get(link.code, ipHash, since);
      if (dup) return { recorded: false, reason: 'deduped' };
    }

    recordVisit({
      linkCode: link.code,
      path: '/',
      ip: input.ip,
      country: input.country,
      userAgent: input.userAgent,
      referrer: input.referrer,
      details: { src: 'beacon' },
    });
    return { recorded: true };
  } catch (err) {
    log.warn('attribution: recordFirstPartyVisit failed', { slug: input.slug, err });
    return { recorded: false, reason: 'error' };
  }
}

/**
 * Delete visit rows strictly older than the retention window. Returns the count.
 * Called from the host-sweep maintenance step (`visit_telemetry_retention_days`).
 */
export function pruneVisitTelemetry(db: Database.Database, retentionDays: number): number {
  if (!hasTable(db, 'visit_telemetry')) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare('DELETE FROM visit_telemetry WHERE ts < ?').run(cutoff);
  return result.changes;
}
