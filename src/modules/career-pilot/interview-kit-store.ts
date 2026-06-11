/**
 * interview-kits data layer (STRATEGY.md §24.53) — pure DB ops + the
 * status→round→interview_type derivations. NO Drive I/O (that lives in the
 * `persist_interview_kit` host handler) and NO LLM. Unit-tested against an
 * in-memory DB.
 *
 * The `interview_kits` table tracks the per-interview kit Google Docs the host
 * materializes in the career-account Drive: one row per (application_id, round),
 * surfaced later via `drive_url` (joined into the funnel read-model) and archived
 * on terminal-transition or by the backstop sweep.
 */
import type Database from 'better-sqlite3';

/** Application statuses that mean "an interview now exists" — entry triggers a kit. */
export const INTERVIEW_ROUND_STATUSES = ['SCREENING', 'TECH_SCREEN', 'SYS_DESIGN', 'FINAL'] as const;
export type InterviewRound = (typeof INTERVIEW_ROUND_STATUSES)[number];

/** Terminal statuses — entry archives the application's active kits. */
export const TERMINAL_STATUSES = ['OFFER', 'REJECTED', 'WITHDRAWN'] as const;

const INTERVIEW_ROUND_SET: Set<string> = new Set(INTERVIEW_ROUND_STATUSES);
const TERMINAL_SET: Set<string> = new Set(TERMINAL_STATUSES);

/** Is `status` an interview-bearing stage (entry → generate a kit)? */
export function isInterviewRoundStatus(status: string | null | undefined): status is InterviewRound {
  return !!status && INTERVIEW_ROUND_SET.has(status.toUpperCase());
}

/** Is `status` terminal (entry → archive the application's active kits)? */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_SET.has(status.toUpperCase());
}

/** round (the interview-bearing status) → the kit's `interview_type`. */
const INTERVIEW_TYPE_BY_ROUND: Record<InterviewRound, string> = {
  SCREENING: 'recruiter_screen',
  TECH_SCREEN: 'technical_screen',
  SYS_DESIGN: 'system_design',
  FINAL: 'final_round',
};

/** Deterministic `interview_type` for a round; defaults to recruiter_screen for an unknown status. */
export function deriveInterviewType(round: string): string {
  return (INTERVIEW_TYPE_BY_ROUND as Record<string, string>)[round.toUpperCase()] ?? 'recruiter_screen';
}

export interface InterviewKitRow {
  id: string;
  application_id: string;
  round: string;
  interview_type: string;
  drive_file_id: string;
  drive_url: string;
  title: string;
  interview_at: string | null;
  status: string; // 'active' | 'archived'
  created_at: string;
  archived_at: string | null;
  /** Kit source markdown (§24.65) — NULL for kits persisted pre-migration-130. */
  markdown: string | null;
}

export interface UpsertInterviewKitInput {
  application_id: string;
  round: string;
  interview_type: string;
  drive_file_id: string;
  drive_url: string;
  title: string;
  interview_at?: string | null;
  /** Omitted/undefined ⇒ an existing row's stored markdown is preserved. */
  markdown?: string | null;
}

function newKitId(): string {
  return `kit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Idempotent UPSERT keyed on (application_id, round): a second kit for the same
 * round updates the existing row in place (manual-refresh / re-run), keeping its
 * `id` and `created_at`, and re-activates an archived row (status→'active',
 * archived_at→NULL). Returns the row id (existing or new). `round` is normalized
 * to upper-case.
 */
export function upsertInterviewKit(db: Database.Database, input: UpsertInterviewKitInput): string {
  const round = input.round.toUpperCase();
  db.prepare(
    `INSERT INTO interview_kits (
       id, application_id, round, interview_type, drive_file_id, drive_url,
       title, interview_at, markdown, status, created_at, archived_at
     ) VALUES (
       @id, @application_id, @round, @interview_type, @drive_file_id, @drive_url,
       @title, @interview_at, @markdown, 'active', @now, NULL
     )
     ON CONFLICT(application_id, round) DO UPDATE SET
       interview_type = excluded.interview_type,
       drive_file_id  = excluded.drive_file_id,
       drive_url      = excluded.drive_url,
       title          = excluded.title,
       interview_at   = excluded.interview_at,
       markdown       = COALESCE(excluded.markdown, interview_kits.markdown),
       status         = 'active',
       archived_at    = NULL`,
  ).run({
    id: newKitId(),
    application_id: input.application_id,
    round,
    interview_type: input.interview_type,
    drive_file_id: input.drive_file_id,
    drive_url: input.drive_url,
    title: input.title,
    interview_at: input.interview_at ?? null,
    markdown: input.markdown ?? null,
    now: new Date().toISOString(),
  });
  const row = db
    .prepare('SELECT id FROM interview_kits WHERE application_id = ? AND round = ?')
    .get(input.application_id, round) as { id: string };
  return row.id;
}

const KIT_COLUMNS = `id, application_id, round, interview_type, drive_file_id, drive_url,
                     title, interview_at, status, created_at, archived_at, markdown`;

/** The kit for (application, round), or undefined — the create-vs-update / idempotency guard. */
export function getKitByApplicationRound(
  db: Database.Database,
  applicationId: string,
  round: string,
): InterviewKitRow | undefined {
  return db
    .prepare(`SELECT ${KIT_COLUMNS} FROM interview_kits WHERE application_id = ? AND round = ?`)
    .get(applicationId, round.toUpperCase()) as InterviewKitRow | undefined;
}

/** Is there an ACTIVE kit for (application, round)? The trigger's "don't re-generate" guard. */
export function hasActiveKit(db: Database.Database, applicationId: string, round: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM interview_kits WHERE application_id = ? AND round = ? AND status = 'active'")
    .get(applicationId, round.toUpperCase());
  return row !== undefined;
}

/** Active kits for an application (e.g. to archive on a terminal transition). */
export function getActiveKitsForApplication(db: Database.Database, applicationId: string): InterviewKitRow[] {
  return db
    .prepare(`SELECT ${KIT_COLUMNS} FROM interview_kits WHERE application_id = ? AND status = 'active'`)
    .all(applicationId) as InterviewKitRow[];
}

/** Mark one kit archived (call AFTER the Drive Doc has been moved to Archive/). Idempotent. */
export function markKitArchived(db: Database.Database, kitId: string, archivedAtIso = new Date().toISOString()): void {
  db.prepare("UPDATE interview_kits SET status = 'archived', archived_at = ? WHERE id = ?").run(archivedAtIso, kitId);
}

/**
 * Newest ACTIVE kit `drive_url` per application id, restricted to `applicationIds`
 * — feeds the `read_funnel_state` join so the orchestrator can surface the link.
 * Returns a Map keyed by application_id. An empty input returns an empty Map.
 */
export function getActiveKitUrlsByApplication(db: Database.Database, applicationIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (applicationIds.length === 0) return out;
  const wanted = new Set(applicationIds);
  // rowid DESC = newest-inserted first (deterministic even when created_at ties
  // to the same millisecond); the latest round's kit wins per application.
  const rows = db
    .prepare("SELECT application_id, drive_url FROM interview_kits WHERE status = 'active' ORDER BY rowid DESC")
    .all() as Array<{ application_id: string; drive_url: string }>;
  for (const r of rows) {
    if (wanted.has(r.application_id) && !out.has(r.application_id)) {
      out.set(r.application_id, r.drive_url);
    }
  }
  return out;
}

/**
 * Active kits the backstop sweep should archive: the application is terminal, OR
 * it is non-terminal but has had no activity since `staleBeforeIso` (a ghosted
 * process that never sent a clean terminal email). The caller derives
 * `staleBeforeIso` from the configured ghosting threshold, then moves each Doc +
 * `markKitArchived`. Does not mutate — pure read.
 */
export function findKitsToArchive(db: Database.Database, staleBeforeIso: string): InterviewKitRow[] {
  return db
    .prepare(
      `SELECT k.*
         FROM interview_kits k
         JOIN applications a ON a.id = k.application_id
        WHERE k.status = 'active'
          AND ( a.status IN ('OFFER', 'REJECTED', 'WITHDRAWN')
                OR COALESCE(a.last_activity_at, a.created_at) < @staleBefore )`,
    )
    .all({ staleBefore: staleBeforeIso }) as InterviewKitRow[];
}
