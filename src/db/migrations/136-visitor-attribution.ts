/**
 * Migration 136 — visitor attribution + visit telemetry (STRATEGY.md §24.74).
 *
 * `attribution_link`: one row per minted `/r/<code>` short link. Minted
 * automatically + host-side at outbound-artifact composition (the outreach-email
 * footer and the master résumé PDF footer — §24.74 D2); resolving the code
 * records a click and 302s to `dest_path` (always '/' per D1, stored for
 * flexibility). `company` is the attribution key (for outreach: the recipient's
 * email domain, a deterministic host-side signal; NULL for the anonymous master
 * PDF). Owner-private — surfaced only on the Access-gated `/admin` (§17.2).
 *
 * `visit_telemetry`: one row per resolved click (and, later, per first-party
 * page-view beacon — `link_code` is nullable for that future path). First-party,
 * minimized (§24.74 D4): a SALTED HASH of the IP (repeat-visit detection without
 * the raw address), COARSE geo (country/region from Cloudflare), a UA *class*
 * (not the full string), and the referrer *host* (not the full URL). Never a
 * public surface (public_audit_trail stays the curated showcase). Pruned by the
 * host-sweep maintenance step (`visit_telemetry_retention_days`).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration136: Migration = {
  version: 136,
  name: 'career-pilot-visitor-attribution',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE attribution_link (
        code           TEXT PRIMARY KEY,          -- the opaque short code in /r/<code>
        artifact_type  TEXT NOT NULL,             -- 'outreach' | 'master_pdf' | ...
        company        TEXT,                      -- attribution key (outreach: recipient domain); NULL when unknown
        recipient      TEXT,                      -- owner-private; the outreach recipient (NULL for master_pdf)
        application_id TEXT,                       -- optional link to an applications row
        dest_path      TEXT NOT NULL DEFAULT '/', -- where /r/<code> 302s to (always '/' per D1)
        created_at     TEXT NOT NULL,             -- ISO 8601 UTC
        expires_at     TEXT                       -- optional; NULL = no expiry
      );

      CREATE INDEX idx_attribution_link_company  ON attribution_link(company);
      CREATE INDEX idx_attribution_link_artifact ON attribution_link(artifact_type, created_at);

      CREATE TABLE visit_telemetry (
        id           TEXT PRIMARY KEY,
        ts           TEXT NOT NULL,               -- ISO 8601 UTC
        link_code    TEXT,                        -- resolved attribution_link.code; NULL for non-token visits
        path         TEXT,                        -- the landing/destination path
        ip_hash      TEXT,                        -- salted hash of the client IP; NULL when no IP
        country      TEXT,                        -- coarse geo (CF country); NULL unknown
        region       TEXT,                        -- coarse region; NULL
        ua_class     TEXT,                        -- 'bot' | 'mobile' | 'desktop' | 'other'; a class, not the raw UA
        referrer     TEXT,                        -- the referrer HOST (not the full URL); NULL
        details_json TEXT
      );

      CREATE INDEX idx_visit_telemetry_ts   ON visit_telemetry(ts DESC);
      CREATE INDEX idx_visit_telemetry_link ON visit_telemetry(link_code, ts);
    `);
  },
};
