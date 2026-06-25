/**
 * Tests for migration 143 (STRATEGY.md §24.177 D4 follow-up): consolidating the
 * legacy random-coded master_pdf attribution row onto the fixed named source
 * `master_resume_pdf`, preserving its click history.
 *
 * Runs migration143.up directly against a minimal attribution schema.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration143 } from './143-master-pdf-named-source.js';

function seedAttributionSchema(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE attribution_link (
      code           TEXT PRIMARY KEY,
      artifact_type  TEXT NOT NULL,
      company        TEXT,
      recipient      TEXT,
      application_id TEXT,
      dest_path      TEXT NOT NULL DEFAULT '/',
      created_at     TEXT NOT NULL,
      expires_at     TEXT
    );
    CREATE TABLE visit_telemetry (
      id        TEXT PRIMARY KEY,
      ts        TEXT NOT NULL,
      link_code TEXT,
      ip_hash   TEXT
    );
  `);
  return db;
}

function link(db: Database.Database, code: string, artifact: string, createdAt: string): void {
  db.prepare(`INSERT INTO attribution_link (code, artifact_type, dest_path, created_at) VALUES (?, ?, '/', ?)`).run(
    code,
    artifact,
    createdAt,
  );
}
function visit(db: Database.Database, id: string, code: string, ipHash: string): void {
  db.prepare(`INSERT INTO visit_telemetry (id, ts, link_code, ip_hash) VALUES (?, '2026-06-20T00:00:00Z', ?, ?)`).run(
    id,
    code,
    ipHash,
  );
}
function codes(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT code FROM attribution_link WHERE artifact_type = 'master_pdf' ORDER BY code`).all() as {
      code: string;
    }[]
  ).map((r) => r.code);
}

describe('migration 143 — master_pdf → named source', () => {
  it('repoints a legacy random-coded master row onto master_resume_pdf, preserving clicks', () => {
    const db = seedAttributionSchema();
    link(db, 'rNr1xfxJ', 'master_pdf', '2026-06-10T00:00:00Z');
    link(db, 'out1', 'outreach', '2026-06-11T00:00:00Z'); // untouched
    visit(db, 'v1', 'rNr1xfxJ', 'iphashA');
    visit(db, 'v2', 'rNr1xfxJ', 'iphashB');
    visit(db, 'v3', 'out1', 'iphashC');

    migration143.up(db);

    // One canonical master source, the random one gone.
    expect(codes(db)).toEqual(['master_resume_pdf']);
    // The master row carries the OLDEST legacy created_at.
    const created = (
      db.prepare(`SELECT created_at FROM attribution_link WHERE code = 'master_resume_pdf'`).get() as {
        created_at: string;
      }
    ).created_at;
    expect(created).toBe('2026-06-10T00:00:00Z');
    // Clicks repointed; the outreach visit is untouched.
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM visit_telemetry WHERE link_code = 'master_resume_pdf'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM visit_telemetry WHERE link_code = 'out1'`).get() as { n: number }).n,
    ).toBe(1);
  });

  it('merges when both a legacy row AND the canonical row already exist', () => {
    const db = seedAttributionSchema();
    link(db, 'oldcode', 'master_pdf', '2026-06-09T00:00:00Z');
    link(db, 'master_resume_pdf', 'master_pdf', '2026-06-24T00:00:00Z'); // already minted post-§24.177
    visit(db, 'v1', 'oldcode', 'iphashA');
    visit(db, 'v2', 'master_resume_pdf', 'iphashB');

    migration143.up(db);

    expect(codes(db)).toEqual(['master_resume_pdf']);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM visit_telemetry WHERE link_code = 'master_resume_pdf'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });

  it('is a no-op on a DB that never minted a master link, and is idempotent', () => {
    const db = seedAttributionSchema();
    link(db, 'out1', 'outreach', '2026-06-11T00:00:00Z');
    migration143.up(db);
    expect(codes(db)).toEqual([]);

    // With a canonical row present, a second run changes nothing.
    link(db, 'master_resume_pdf', 'master_pdf', '2026-06-24T00:00:00Z');
    migration143.up(db);
    migration143.up(db);
    expect(codes(db)).toEqual(['master_resume_pdf']);
  });
});
