/**
 * Migration 140 — contact submissions (STRATEGY.md §24.121).
 *
 * Persists `/contact` relay submissions so the orchestrator can RECALL them
 * (the owner-only `read_contacts` tool) and act on an owner-initiated turn —
 * "how should I reply to that Acme contact?" / "add that one to my
 * pipeline". The public form never triggers an agent turn (zero spend).
 *
 * Reverses the §24.22 "not persisted" choice. Because persistence is a new
 * junk-row vector, the relay gates inserts with dedup + a global flood cap and
 * prunes to a bounded retention (all §24.121). `fingerprint` (sha256 of the
 * normalized email|company|role|message) backs the dedup; `delivered` records
 * whether the Telegram relay succeeded; the created-at index backs both the
 * flood-cap window count and the recent-first read.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration140: Migration = {
  version: 140,
  name: 'career-pilot-contact-submissions',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_submissions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        company TEXT,
        role TEXT,
        source TEXT,
        message TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contact_submissions_created
        ON contact_submissions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_submissions_fp
        ON contact_submissions(fingerprint, created_at DESC);
    `);
  },
};
