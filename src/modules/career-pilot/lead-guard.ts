/**
 * src/modules/career-pilot/lead-guard.ts — the ONE pre-insert guard every
 * job_leads writer shares (STRATEGY.md §24.200 D1 + D2, §24.201 D4).
 *
 * Before §24.200 the search path computed `apply_link_kind` and then recorded the
 * lead anyway, and a hard delete had no memory, so the owner's deleting never
 * converged. This module decides — for one normalized payload — whether it may
 * enter the pool at all. It refuses, in order:
 *
 *   1. `link_kind` — a SEARCH-sourced payload whose kind is in
 *      `lead_reject_link_kinds` (default aggregator + unknown). A missing kind is
 *      resolved exactly as the insert resolves it (`resolveApplyLinkKind`).
 *   2. `tombstone` — a posting the owner (or the purge) already removed. See
 *      `matchTombstone` for the id-vs-fingerprint reach.
 *   3. `title_blocklist` — a title on the owner's `lead_title_blocklist`
 *      (case-insensitive whole-title equality).
 *
 * Callers: `upsertJobLead` (the writer — so every path honours it) and
 * `handleStashJobPayloads` (early, so a refused payload is never cached and the
 * existing NOT_IN_CACHE check makes the gate unbypassable by the subagent).
 *
 * Pure-ish: reads config + the tombstone table; the only writers here are
 * `writeTombstone`, `clearNotInterestedTombstones` and the title-blocklist
 * append/remove pair. Never throws on a missing table
 * (an un-migrated test DB reads as "no tombstones").
 */
import type Database from 'better-sqlite3';

import { hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

import { companyToken, type ApplyLinkKind } from './apply-link.js';
import { computeFingerprint, hammingDistance } from './lead-fingerprint.js';
import type { JobLeadPayload, Source } from './scrape-jobs/types.js';

export type LeadRefusalReason = 'link_kind' | 'tombstone' | 'title_blocklist';

export type LeadGuardResult =
  | { ok: true }
  | { ok: false; reason: LeadRefusalReason; detail: string; tombstone_id?: string };

/** The fingerprint `computeFingerprint` returns for a payload with no usable tokens. Never matches. */
export const ZERO_FINGERPRINT = '0000000000000000';

/** Sources that come from the search index (query-based), as opposed to an employer's own board. */
const SEARCH_SOURCES: ReadonlySet<string> = new Set<Source>(['google_jobs']);

export function isSearchSourced(source: string): boolean {
  return SEARCH_SOURCES.has(source);
}

/**
 * The kind the writer stores for a payload: its own `apply_link_kind`, else —
 * for a payload that did not say — 'unknown' on the search path (a hit with no
 * classified link) and 'ats' for a board adapter (direct by construction).
 */
export function resolveApplyLinkKind(p: { source: string; apply_link_kind?: string | null }): ApplyLinkKind {
  if (p.apply_link_kind) return p.apply_link_kind as ApplyLinkKind;
  return isSearchSourced(p.source) ? 'unknown' : 'ats';
}

/** A kind the owner can apply through directly. */
function isDirectKind(kind: string): boolean {
  return kind === 'ats' || kind === 'company';
}

/** True when this (source, kind) is one the insert guard refuses on its link alone. */
export function isRejectedLinkKind(
  db: Database.Database,
  p: { source: string; apply_link_kind?: string | null },
): boolean {
  if (!isSearchSourced(p.source)) return false;
  const rejected = getConfig<string[]>(db, 'lead_reject_link_kinds');
  return Array.isArray(rejected) && rejected.includes(resolveApplyLinkKind(p));
}

/** Whole-title comparison key: case-insensitive, surrounding whitespace ignored. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The owner's title blocklist as stored (non-empty strings only). */
export function readTitleBlocklist(db: Database.Database): string[] {
  const raw = getConfig<unknown>(db, 'lead_title_blocklist');
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
}

export function isTitleBlocklisted(db: Database.Database, title: string): boolean {
  const key = normalizeTitle(title);
  if (!key) return false;
  return readTitleBlocklist(db).some((t) => normalizeTitle(t) === key);
}

/**
 * Append a title to the owner's `lead_title_blocklist` preference (deduped by the
 * same whole-title key the guard matches with). Returns true when the title is on
 * the list afterwards. Writes the preferences tier directly — the list is an
 * owner-mutable preference, grown by "not interested → exclude this title".
 */
export function appendTitleToBlocklist(db: Database.Database, title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  const list = readTitleBlocklist(db);
  if (list.some((t) => normalizeTitle(t) === normalizeTitle(trimmed))) return true;
  list.push(trimmed);
  writeTitleBlocklist(db, list);
  return true;
}

/**
 * Remove a title from the blocklist (matched by the same whole-title key) — the
 * way back from "exclude this title". Returns true when an entry was removed.
 */
export function removeTitleFromBlocklist(db: Database.Database, title: string): boolean {
  const key = normalizeTitle(title);
  if (!key) return false;
  const list = readTitleBlocklist(db);
  const kept = list.filter((t) => normalizeTitle(t) !== key);
  if (kept.length === list.length) return false;
  writeTitleBlocklist(db, kept);
  return true;
}

function writeTitleBlocklist(db: Database.Database, list: string[]): void {
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES ('lead_title_blocklist', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(list), new Date().toISOString());
}

/**
 * Delete the "not interested" tombstones written for one lead's own posting
 * (same source + source_job_id). Called when the owner moves that lead back out
 * of `archived` — they chose the posting after all, so it must stop refusing its
 * re-sightings and near-identical siblings. Deletion and link tombstones stay.
 * Returns the number removed.
 */
export function clearNotInterestedTombstones(db: Database.Database, leadId: string): number {
  if (!hasTable(db, 'job_lead_tombstones')) return 0;
  const lead = db.prepare('SELECT source, source_job_id FROM job_leads WHERE id = ?').get(leadId) as
    | { source: string; source_job_id: string }
    | undefined;
  if (!lead) return 0;
  return db
    .prepare(
      `DELETE FROM job_lead_tombstones
        WHERE source = ? AND source_job_id = ? AND reason LIKE 'not\\_interested:%' ESCAPE '\\'`,
    )
    .run(lead.source, lead.source_job_id).changes;
}

interface TombstoneRow {
  id: string;
  source: string;
  source_job_id: string;
  content_fingerprint: string | null;
  company: string | null;
  title: string | null;
  reason: string;
  match: 'id' | 'fingerprint';
}

/** A tombstone written because of the link (the purge, a hard delete of a rejected-kind lead). */
function isLinkReason(reason: string): boolean {
  return reason.startsWith('link:');
}

function fingerprintsMatch(a: string | null, b: string | null, maxBits: number): boolean {
  if (!a || !b) return false;
  if (a === ZERO_FINGERPRINT || b === ZERO_FINGERPRINT) return false;
  if (a.length !== b.length) return false;
  return hammingDistance(a, b) <= maxBits;
}

/**
 * The tombstone (if any) that refuses this payload.
 *
 *  - Same (source, source_job_id): refused — EXCEPT a link-reason tombstone,
 *    which only ever refuses while the posting still arrives without a direct
 *    link. The job was fine, only the link was bad.
 *  - A `match='fingerprint'` tombstone additionally refuses a payload from the
 *    same normalized company whose SimHash is within `lead_tombstone_hamming_max`
 *    bits. An all-zero fingerprint (either side) never matches.
 */
export function matchTombstone(
  db: Database.Database,
  p: JobLeadPayload,
  fingerprint?: string,
): { tombstone: TombstoneRow; via: 'id' | 'fingerprint' } | null {
  if (!hasTable(db, 'job_lead_tombstones')) return null;

  const byId = db
    .prepare(
      `SELECT id, source, source_job_id, content_fingerprint, company, title, reason, match
         FROM job_lead_tombstones WHERE source = ? AND source_job_id = ? ORDER BY created_at DESC`,
    )
    .all(p.source, p.source_job_id) as TombstoneRow[];
  const kind = resolveApplyLinkKind(p);
  for (const t of byId) {
    if (isLinkReason(t.reason) && isDirectKind(kind)) continue;
    return { tombstone: t, via: 'id' };
  }

  const fpTombstones = db
    .prepare(
      `SELECT id, source, source_job_id, content_fingerprint, company, title, reason, match
         FROM job_lead_tombstones WHERE match = 'fingerprint'`,
    )
    .all() as TombstoneRow[];
  if (fpTombstones.length === 0) return null;

  const fp = fingerprint ?? computeFingerprint(p);
  if (fp === ZERO_FINGERPRINT) return null;
  const company = companyToken(p.company ?? '');
  if (!company) return null;
  const maxBits = getConfig<number>(db, 'lead_tombstone_hamming_max');
  for (const t of fpTombstones) {
    if (companyToken(t.company ?? '') !== company) continue;
    if (fingerprintsMatch(t.content_fingerprint, fp, maxBits)) return { tombstone: t, via: 'fingerprint' };
  }
  return null;
}

/**
 * Decide whether one payload may enter job_leads. `fingerprint` may be passed
 * when the caller already computed it (the writer does).
 */
export function checkLeadGuard(db: Database.Database, p: JobLeadPayload, fingerprint?: string): LeadGuardResult {
  if (isRejectedLinkKind(db, p)) {
    return { ok: false, reason: 'link_kind', detail: `apply link kind '${resolveApplyLinkKind(p)}' is not accepted` };
  }

  const hit = matchTombstone(db, p, fingerprint);
  if (hit) {
    if (hit.via === 'fingerprint') {
      log.info('lead guard: fingerprint tombstone refused a posting', {
        source: p.source,
        source_job_id: p.source_job_id,
        company: p.company,
        tombstone_id: hit.tombstone.id,
        tombstone_source_job_id: hit.tombstone.source_job_id,
        tombstone_reason: hit.tombstone.reason,
      });
    }
    return {
      ok: false,
      reason: 'tombstone',
      detail: `removed earlier (${hit.tombstone.reason}, ${hit.via} match)`,
      tombstone_id: hit.tombstone.id,
    };
  }

  if (isTitleBlocklisted(db, p.title ?? '')) {
    return { ok: false, reason: 'title_blocklist', detail: 'title is on the owner blocklist' };
  }
  return { ok: true };
}

export interface TombstoneInput {
  source: string;
  source_job_id: string;
  content_fingerprint: string | null;
  company: string | null;
  title: string | null;
  reason: string;
  match: 'id' | 'fingerprint';
}

/** Record that a posting was removed, and with what reach. Returns the tombstone id. */
export function writeTombstone(db: Database.Database, t: TombstoneInput): string {
  const id = `tomb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO job_lead_tombstones
       (id, source, source_job_id, content_fingerprint, company, title, reason, match, created_at)
     VALUES (@id, @source, @source_job_id, @content_fingerprint, @company, @title, @reason, @match, @created_at)`,
  ).run({ id, ...t, created_at: new Date().toISOString() });
  return id;
}
