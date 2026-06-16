/**
 * src/modules/portal/admin.ts — the owner-only `/admin` surface (STRATEGY §24.74
 * D5 + §17.2). Read-only.
 *
 * Gating (`adminEnabled`): OPEN on the dev stack — the whole dev surface already
 * sits behind owner-only Cloudflare Access, the same trust model the dev
 * inspector relies on. FAIL-CLOSED on any other stack until the owner both wires
 * the prod `/admin*` + `/api/admin/*` Cloudflare Access app (the PRIMARY edge
 * gate) AND flips `admin_api_enabled` (the host kill-switch / defense-in-depth
 * belt). So on prod the surface 404s by default — never exposed to the public
 * site before it's deliberately turned on.
 *
 * Commit 3 ships the attribution browser — the §24.74 deliverable: the minted
 * `/r/<code>` links joined to their `visit_telemetry` clicks (who came from
 * which outbound artifact, from where). The broader §17.2 panels (cost rollups,
 * health, contact submissions) are a follow-up. Nothing here is a writer, and
 * the recruiter-sim / dev knobs are deliberately absent (prod-safe by design).
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';

import { originJwtEnabled } from './access-jwt.js';
import { isDevEnv } from './dev-inspector.js';

/**
 * True when the owner-only admin surface may serve. Dev → always (owner-gated
 * surface). Otherwise → only when `admin_api_enabled` is set AND origin-JWT
 * validation is active (Access is enforced) — the host belt behind the edge
 * Access app. Never throws.
 */
export function adminEnabled(): boolean {
  if (isDevEnv()) return true;
  try {
    return getConfig<boolean>(getDb(), 'admin_api_enabled', false) && originJwtEnabled();
  } catch {
    return false;
  }
}

export interface AttributionLinkRow {
  code: string;
  artifactType: string;
  company: string | null;
  /** Owner-private (the address we cold-emailed) — only ever served behind the admin gate. */
  recipient: string | null;
  createdAt: string;
  clicks: number;
  uniqueVisitors: number;
  lastClickAt: string | null;
}

export interface AttributionVisit {
  ts: string;
  linkCode: string | null;
  company: string | null;
  country: string | null;
  uaClass: string | null;
  referrer: string | null;
}

export interface AttributionReport {
  links: AttributionLinkRow[];
  recentVisits: AttributionVisit[];
  summary: {
    totalLinks: number;
    totalClicks: number;
    totalUniqueVisitors: number;
    byArtifact: Record<string, number>;
    topCountries: { country: string; clicks: number }[];
  };
}

const EMPTY_REPORT: AttributionReport = {
  links: [],
  recentVisits: [],
  summary: { totalLinks: 0, totalClicks: 0, totalUniqueVisitors: 0, byArtifact: {}, topCountries: [] },
};

/**
 * The attribution browser's read-model: every minted link with its click
 * aggregates, the recent visit feed, and a small summary. Pure read over the two
 * private tables; returns an empty report on an un-migrated DB.
 */
export function buildAttributionReport(db: Database.Database, opts: { recentLimit?: number } = {}): AttributionReport {
  if (!hasTable(db, 'attribution_link') || !hasTable(db, 'visit_telemetry')) return EMPTY_REPORT;

  const links = db
    .prepare(
      `SELECT l.code, l.artifact_type AS artifactType, l.company, l.recipient, l.created_at AS createdAt,
              COUNT(v.id) AS clicks, COUNT(DISTINCT v.ip_hash) AS uniqueVisitors, MAX(v.ts) AS lastClickAt
       FROM attribution_link l
       LEFT JOIN visit_telemetry v ON v.link_code = l.code
       GROUP BY l.code
       ORDER BY clicks DESC, l.created_at DESC`,
    )
    .all() as AttributionLinkRow[];

  const byArtifact: Record<string, number> = {};
  for (const l of links) byArtifact[l.artifactType] = (byArtifact[l.artifactType] ?? 0) + 1;

  const totalClicks = (
    db.prepare('SELECT COUNT(*) AS n FROM visit_telemetry WHERE link_code IS NOT NULL').get() as { n: number }
  ).n;
  const totalUniqueVisitors = (
    db.prepare('SELECT COUNT(DISTINCT ip_hash) AS n FROM visit_telemetry WHERE ip_hash IS NOT NULL').get() as {
      n: number;
    }
  ).n;
  const topCountries = db
    .prepare(
      `SELECT country, COUNT(*) AS clicks FROM visit_telemetry
       WHERE country IS NOT NULL GROUP BY country ORDER BY clicks DESC, country ASC LIMIT 8`,
    )
    .all() as { country: string; clicks: number }[];

  const recentLimit = opts.recentLimit ?? 50;
  const recentVisits = db
    .prepare(
      `SELECT v.ts, v.link_code AS linkCode, l.company, v.country, v.ua_class AS uaClass, v.referrer
       FROM visit_telemetry v
       LEFT JOIN attribution_link l ON l.code = v.link_code
       ORDER BY v.ts DESC LIMIT ?`,
    )
    .all(recentLimit) as AttributionVisit[];

  return {
    links,
    recentVisits,
    summary: { totalLinks: links.length, totalClicks, totalUniqueVisitors, byArtifact, topCountries },
  };
}
