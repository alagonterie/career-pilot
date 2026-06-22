/**
 * src/modules/portal/public-pipeline-view.ts — Phase 5 BFF-readiness read-model.
 *
 * `public_audit_trail` is an append-only event log; the portal pipeline
 * surfaces (`/` strip, `/pipeline` board, `/live` compact pipeline) need current
 * state per application. `public_pipeline_view` (migration 124) is a maintained
 * physical projection — one row per application — that the portal API reads
 * directly (`SELECT * FROM public_pipeline_view`), never touching the private
 * `applications` / `learnings` tables.
 *
 * `upsertPublicPipelineView(db, applicationId)` recomputes one application's row
 * from the canonical private tables, sanitizing any free-text (the published
 * reflection excerpt) before it lands. Called best-effort AFTER the action
 * handler's `writeResponse` — identical discipline to `mirrorPipelineEvent`:
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

// status → the public pipeline stage shown on the portal. The five primary
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

export function derivePipelineStage(status: string | null | undefined): string {
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
  win_confidence_rationale: string | null;
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
 * Recompute and UPSERT one application's row in `public_pipeline_view`.
 * Best-effort: never throws. Call AFTER the private write commits +
 * `writeResponse` returns.
 */
export function upsertPublicPipelineView(db: Database.Database, applicationId: string): void {
  try {
    const app = db
      .prepare(
        `SELECT id, company_name, obfuscated_label, public_state, role_title,
                status, win_confidence, win_confidence_rationale, applied_at, last_activity_at, created_at
           FROM applications
          WHERE id = ?`,
      )
      .get(applicationId) as AppRow | undefined;

    if (!app) {
      // No application to project (deleted, or never existed). Nothing to do.
      return;
    }

    const applicationRef = app.public_state === 'public' ? app.company_name : app.obfuscated_label;
    const stage = derivePipelineStage(app.status);

    // stage_entered_at: when the application last transitioned TO its current
    // status (latest matching pipeline_events row); fall back to its activity
    // timestamps if no such event exists.
    let stageEnteredAt: string | null = app.last_activity_at ?? app.applied_at ?? app.created_at ?? null;
    try {
      const fe = db
        .prepare(
          `SELECT ts FROM pipeline_events
            WHERE application_id = ? AND to_status = ?
            ORDER BY ts DESC LIMIT 1`,
        )
        .get(applicationId, app.status) as { ts: string } | undefined;
      if (fe?.ts) stageEnteredAt = fe.ts;
    } catch (err) {
      log.warn('upsertPublicPipelineView: stage_entered_at lookup failed', { applicationId, err });
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
      log.warn('upsertPublicPipelineView: published learning lookup failed', { applicationId, err });
    }

    // learnings_json (§24.117): ALL published reflections for this app, newest
    // first ({kind, created_at, excerpt}) — the /pipeline drawer's "Lessons
    // learned" list. Each excerpt runs the same sanitize+truncate as the legacy
    // single `published_learning` (the twin of kits_json). Twin best-effort try.
    let learningsJson: string | null = null;
    try {
      const learnRows = db
        .prepare(
          `SELECT kind, reflections, created_at FROM learnings
            WHERE application_id = ? AND reflection_published = 1
            ORDER BY created_at DESC`,
        )
        .all(applicationId) as Array<{ kind: string; reflections: string; created_at: string }>;
      const learnings = learnRows
        .map((r) => ({
          kind: r.kind,
          created_at: r.created_at,
          excerpt: buildLearningExcerpt(r.reflections, applicationId, db),
        }))
        .filter((l) => l.excerpt.length > 0);
      if (learnings.length > 0) learningsJson = JSON.stringify(learnings);
    } catch (err) {
      log.warn('upsertPublicPipelineView: learnings_json lookup failed', { applicationId, err });
    }

    // win_confidence_rationale: the LLM's one-liner, sanitized like a learning
    // (Pass 1 PII + Pass 2 company redaction) before it lands on the public view.
    const winRationale = app.win_confidence_rationale
      ? sanitize(app.win_confidence_rationale, { application_id: applicationId, db })
      : null;

    // kits_json (§24.65): per-kit existence metadata for the /pipeline drawer —
    // ALL kits incl. archived (D1: a closed process keeps its prep story).
    // Enums + timestamps only; the kit's title/drive_url/markdown never land here.
    let kitsJson: string | null = null;
    try {
      const kits = db
        .prepare(
          `SELECT round, interview_type, interview_at, status, created_at,
                  CASE WHEN markdown IS NOT NULL AND markdown != '' THEN 1 ELSE 0 END AS has_content
             FROM interview_kits
            WHERE application_id = ?
            ORDER BY created_at ASC, rowid ASC`,
        )
        .all(applicationId) as Array<{
        round: string;
        interview_type: string;
        interview_at: string | null;
        status: string;
        created_at: string;
        has_content: number;
      }>;
      if (kits.length > 0) {
        kitsJson = JSON.stringify(kits.map((k) => ({ ...k, has_content: k.has_content === 1 })));
      }
    } catch (err) {
      log.warn('upsertPublicPipelineView: kits_json lookup failed', { applicationId, err });
    }

    db.prepare(
      `INSERT INTO public_pipeline_view (
         application_id, application_ref, public_state, role_title, status, stage,
         applied_at, stage_entered_at, last_activity_at, win_confidence,
         win_confidence_rationale, published_learning, learnings_json, kits_json, updated_at
       ) VALUES (
         @application_id, @application_ref, @public_state, @role_title, @status, @stage,
         @applied_at, @stage_entered_at, @last_activity_at, @win_confidence,
         @win_confidence_rationale, @published_learning, @learnings_json, @kits_json, @updated_at
       )
       ON CONFLICT(application_id) DO UPDATE SET
         application_ref          = excluded.application_ref,
         public_state             = excluded.public_state,
         role_title               = excluded.role_title,
         status                   = excluded.status,
         stage                    = excluded.stage,
         applied_at               = excluded.applied_at,
         stage_entered_at         = excluded.stage_entered_at,
         last_activity_at         = excluded.last_activity_at,
         win_confidence           = excluded.win_confidence,
         win_confidence_rationale = excluded.win_confidence_rationale,
         published_learning       = excluded.published_learning,
         learnings_json           = excluded.learnings_json,
         kits_json                = excluded.kits_json,
         updated_at               = excluded.updated_at`,
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
      win_confidence_rationale: winRationale,
      published_learning: publishedLearning,
      learnings_json: learningsJson,
      kits_json: kitsJson,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    log.error('upsertPublicPipelineView failed', { applicationId, err });
  }
}
