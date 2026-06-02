/**
 * src/modules/portal/public-funnel-view.ts — Phase 5 BFF-readiness read-model.
 *
 * `public_audit_trail` is an append-only event log; the portal funnel
 * surfaces (`/` strip, `/funnel` board, `/live` compact funnel) need current
 * state per application. `public_funnel_view` (migration 124) is a maintained
 * physical projection — one row per application — that the portal API reads
 * directly (`SELECT * FROM public_funnel_view`), never touching the private
 * `applications` / `learnings` tables.
 *
 * `upsertPublicFunnelView(db, applicationId)` recomputes one application's row
 * from the canonical private tables, sanitizing any free-text (the published
 * reflection excerpt) before it lands. Called best-effort AFTER the action
 * handler's `writeResponse` — identical discipline to `mirrorFunnelEvent`:
 * the private write is already committed, so a projection failure is logged
 * and swallowed, never propagated.
 *
 * Schema reference: STRATEGY.md §3 + §24.14.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

import { sanitize } from './sanitizer.js';

// ── Canonical application status vocabulary ────────────────────────────────
//
// Pinned here (the portal read-model is the consumer that most needs a stable
// vocabulary). Previously this existed only as a DDL comment in STRATEGY.md §3
// — unenforced. Validated warn-not-reject by the write handlers.
export const APPLICATION_STATUSES = [
  'BOOKMARKED',
  'APPLIED',
  'SCREENING',
  'TECH_SCREEN',
  'SYS_DESIGN',
  'FINAL',
  'OFFER',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

const APPLICATION_STATUS_SET: Set<string> = new Set(APPLICATION_STATUSES);

export function isKnownApplicationStatus(status: string): boolean {
  return APPLICATION_STATUS_SET.has(status.toUpperCase());
}

// status → the public funnel stage shown on the portal. The five primary
// stages are applied/screening/tech/final/offer; `bookmarked` is a pre-stage
// the frontend may hide, and rejected/withdrawn are terminal. An unknown
// status passes through lowercased so `stage` is never null/empty.
const STAGE_BY_STATUS: Record<string, string> = {
  BOOKMARKED: 'bookmarked',
  APPLIED: 'applied',
  SCREENING: 'screening',
  TECH_SCREEN: 'tech',
  SYS_DESIGN: 'tech',
  FINAL: 'final',
  OFFER: 'offer',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
};

export function deriveFunnelStage(status: string | null | undefined): string {
  if (!status) return 'applied';
  const upper = status.toUpperCase();
  return STAGE_BY_STATUS[upper] ?? status.toLowerCase();
}

// ── Projection ─────────────────────────────────────────────────────────────

const PUBLISHED_LEARNING_MAX_CHARS = 500;

interface AppRow {
  id: string;
  company_name: string;
  obfuscated_label: string;
  public_state: string | null;
  role_title: string | null;
  status: string;
  win_confidence: number | null;
  applied_at: string | null;
  last_activity_at: string | null;
  created_at: string | null;
}

/**
 * Build the sanitized public excerpt for an application's latest published
 * reflection. `learnings.reflections` is a JSON object of free-form answers;
 * we join its string values into a readable line, then run the full sanitizer
 * (Pass 1 regex + Pass 2 company redaction) so no PII or non-public company
 * name survives, and truncate.
 */
function buildLearningExcerpt(reflectionsRaw: string, applicationId: string, db: Database.Database): string {
  let text = reflectionsRaw;
  try {
    const parsed = JSON.parse(reflectionsRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const parts = Object.values(parsed).filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (parts.length > 0) text = parts.join(' · ');
    }
  } catch {
    // Not JSON — sanitize the raw string as-is.
  }
  const sanitized = sanitize(text, { application_id: applicationId, db });
  return sanitized.length > PUBLISHED_LEARNING_MAX_CHARS
    ? `${sanitized.slice(0, PUBLISHED_LEARNING_MAX_CHARS - 1)}…`
    : sanitized;
}

/**
 * Recompute and UPSERT one application's row in `public_funnel_view`.
 * Best-effort: never throws. Call AFTER the private write commits +
 * `writeResponse` returns.
 */
export function upsertPublicFunnelView(db: Database.Database, applicationId: string): void {
  try {
    const app = db
      .prepare(
        `SELECT id, company_name, obfuscated_label, public_state, role_title,
                status, win_confidence, applied_at, last_activity_at, created_at
           FROM applications
          WHERE id = ?`,
      )
      .get(applicationId) as AppRow | undefined;

    if (!app) {
      // No application to project (deleted, or never existed). Nothing to do.
      return;
    }

    const applicationRef = app.public_state === 'public' ? app.company_name : app.obfuscated_label;
    const stage = deriveFunnelStage(app.status);

    // stage_entered_at: when the application last transitioned TO its current
    // status (latest matching funnel_events row); fall back to its activity
    // timestamps if no such event exists.
    let stageEnteredAt: string | null = app.last_activity_at ?? app.applied_at ?? app.created_at ?? null;
    try {
      const fe = db
        .prepare(
          `SELECT ts FROM funnel_events
            WHERE application_id = ? AND to_status = ?
            ORDER BY ts DESC LIMIT 1`,
        )
        .get(applicationId, app.status) as { ts: string } | undefined;
      if (fe?.ts) stageEnteredAt = fe.ts;
    } catch (err) {
      log.warn('upsertPublicFunnelView: stage_entered_at lookup failed', { applicationId, err });
    }

    // published_learning: latest published reflection, sanitized + truncated.
    let publishedLearning: string | null = null;
    try {
      const learn = db
        .prepare(
          `SELECT reflections FROM learnings
            WHERE application_id = ? AND reflection_published = 1
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(applicationId) as { reflections: string } | undefined;
      if (learn?.reflections) {
        publishedLearning = buildLearningExcerpt(learn.reflections, applicationId, db);
      }
    } catch (err) {
      log.warn('upsertPublicFunnelView: published learning lookup failed', { applicationId, err });
    }

    db.prepare(
      `INSERT INTO public_funnel_view (
         application_id, application_ref, public_state, role_title, status, stage,
         applied_at, stage_entered_at, last_activity_at, win_confidence,
         published_learning, updated_at
       ) VALUES (
         @application_id, @application_ref, @public_state, @role_title, @status, @stage,
         @applied_at, @stage_entered_at, @last_activity_at, @win_confidence,
         @published_learning, @updated_at
       )
       ON CONFLICT(application_id) DO UPDATE SET
         application_ref    = excluded.application_ref,
         public_state       = excluded.public_state,
         role_title         = excluded.role_title,
         status             = excluded.status,
         stage              = excluded.stage,
         applied_at         = excluded.applied_at,
         stage_entered_at   = excluded.stage_entered_at,
         last_activity_at   = excluded.last_activity_at,
         win_confidence     = excluded.win_confidence,
         published_learning = excluded.published_learning,
         updated_at         = excluded.updated_at`,
    ).run({
      application_id: app.id,
      application_ref: applicationRef ?? app.obfuscated_label ?? app.id,
      public_state: app.public_state ?? 'obfuscated',
      role_title: app.role_title ?? null,
      status: app.status,
      stage,
      applied_at: app.applied_at ?? null,
      stage_entered_at: stageEnteredAt,
      last_activity_at: app.last_activity_at ?? null,
      win_confidence: app.win_confidence ?? null,
      published_learning: publishedLearning,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    log.error('upsertPublicFunnelView failed', { applicationId, err });
  }
}
