/**
 * Interview-kit host actions (STRATEGY.md §24.53).
 *
 *  - career_pilot.persist_interview_kit — the subagent-owned writer: materialize
 *    (or refresh) a per-interview kit as a native Google Doc in the career-account
 *    Drive, then UPSERT the interview_kits row. Mirrors the funnel-curator
 *    `persist_funnel_state` internal-writer pattern; NOT approval-gated (private,
 *    reversible, no external recipient).
 *
 *  - archiveKitsForApplication / runKitCleanupSweep — host functions (no agent
 *    round-trip) for the symmetric terminal-transition archive (Commit C) and the
 *    backstop cleanup sweep (Commit E). Move the Doc to Archive/ + flip the row.
 *
 * Drive mechanics live in drive-client.ts; this module owns the create-vs-update
 * decision, folder bookkeeping, and the DB writes.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { upsertPublicFunnelView } from '../portal/public-funnel-view.js';
import { upsertPublicKitView } from '../portal/public-kit-view.js';
import type { Session } from '../../types.js';

import { createDoc, createFolder, docUrl, kitMarkdownToHtml, moveFile, updateDocContent } from './drive-client.js';
import {
  findKitsToArchive,
  getActiveKitsForApplication,
  getKitByApplicationRound,
  type InterviewKitRow,
  markKitArchived,
  upsertInterviewKit,
} from './interview-kit-store.js';

// ── response writer (mirrors funnel-actions.ts) ──────────────────────────────

type ActionFrame =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

function writeResponse(inDb: Database.Database, requestId: string, frame: ActionFrame): void {
  insertMessage(inDb, {
    id: `cp-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'career_pilot_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

function reqId(content: Record<string, unknown>): string {
  return (content.requestId as string) || 'unknown';
}

function payload(content: Record<string, unknown>): Record<string, unknown> {
  return (content.payload as Record<string, unknown>) ?? {};
}

/** Persist a runtime-discovered value into the `preferences` tier (read back via getConfig). */
function writePreference(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    new Date().toISOString(),
  );
}

/**
 * Ensure the dedicated kit folder (+ its Archive/ subfolder) exist, persisting
 * their ids to `preferences` (drive.file can't name-search for a folder it didn't
 * create, so the id is the durable handle). Returns the ids; `folderId` is null
 * only when folder creation failed. `archiveId` may be null (archive is optional
 * — the main folder is still usable for creation).
 */
export async function ensureKitFolders(
  db: Database.Database,
): Promise<{ folderId: string | null; archiveId: string | null }> {
  let folderId = getConfig<string>(db, 'interview_kit_drive_folder_id', '');
  if (!folderId) {
    const name = getConfig<string>(db, 'interview_kit_folder_name', 'Career Pilot Interview Kits');
    const id = await createFolder(name);
    if (!id) return { folderId: null, archiveId: null };
    folderId = id;
    writePreference(db, 'interview_kit_drive_folder_id', folderId);
    log.info('interview-kit: created Drive folder', { folderId });
  }

  let archiveId = getConfig<string>(db, 'interview_kit_drive_archive_folder_id', '');
  if (!archiveId) {
    const id = await createFolder('Archive', folderId);
    if (id) {
      archiveId = id;
      writePreference(db, 'interview_kit_drive_archive_folder_id', archiveId);
      log.info('interview-kit: created Archive subfolder', { archiveId });
    }
  }
  return { folderId, archiveId: archiveId || null };
}

// ── career_pilot.persist_interview_kit ───────────────────────────────────────

export async function handlePersistInterviewKit(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  const p = payload(content);
  const applicationId = p.application_id as string;
  const round = String((p.round as string) ?? '').toUpperCase();
  const interviewType = p.interview_type as string;
  const title = p.title as string;
  const markdown = p.markdown as string;
  const interviewAt = (p.interview_at as string | undefined) ?? null;

  if (!applicationId || !round || !interviewType || !title || !markdown) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'application_id, round, interview_type, title, markdown are required' },
    });
    return;
  }

  try {
    const db = getDb();
    const { folderId } = await ensureKitFolders(db);
    if (!folderId) {
      writeResponse(inDb, requestId, {
        ok: false,
        error: { code: 'DRIVE_ERROR', message: 'could not ensure the interview-kit Drive folder' },
      });
      return;
    }

    const html = kitMarkdownToHtml(markdown);
    const existing = getKitByApplicationRound(db, applicationId, round);

    let driveFileId: string;
    let driveUrl: string;
    if (existing && existing.drive_file_id) {
      const ok = await updateDocContent(existing.drive_file_id, html, title);
      if (!ok) {
        writeResponse(inDb, requestId, {
          ok: false,
          error: { code: 'DRIVE_ERROR', message: 'failed to update the existing kit Doc' },
        });
        return;
      }
      driveFileId = existing.drive_file_id;
      driveUrl = existing.drive_url || docUrl(driveFileId);
    } else {
      const created = await createDoc(title, html, folderId);
      if (!created) {
        writeResponse(inDb, requestId, {
          ok: false,
          error: { code: 'DRIVE_ERROR', message: 'failed to create the kit Doc' },
        });
        return;
      }
      driveFileId = created.id;
      driveUrl = created.url;
    }

    const kitId = upsertInterviewKit(db, {
      application_id: applicationId,
      round,
      interview_type: interviewType,
      drive_file_id: driveFileId,
      drive_url: driveUrl,
      title,
      interview_at: interviewAt,
      markdown,
    });

    log.info('interview-kit persisted', { kitId, applicationId, round, updated: !!existing });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { kit_id: kitId, drive_url: driveUrl, drive_file_id: driveFileId, round },
    });

    // §24.65: refresh the public projections AFTER the response frame (same
    // best-effort discipline as every other writer — both functions never throw).
    await upsertPublicKitView(db, applicationId);
    upsertPublicFunnelView(db, applicationId);
  } catch (err) {
    log.error('handlePersistInterviewKit failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'PERSIST_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── archive / cleanup host functions (wired by Commit C + E) ─────────────────

/** Move one kit's Doc to Archive/ (best-effort) then flip its row to archived. */
async function archiveOneKit(
  db: Database.Database,
  kit: InterviewKitRow,
  folderId: string,
  archiveId: string,
): Promise<void> {
  if (folderId && archiveId) {
    const moved = await moveFile(kit.drive_file_id, archiveId, folderId);
    if (!moved) {
      log.warn('interview-kit: Doc move to Archive failed; marking archived in DB anyway', { kitId: kit.id });
    }
  }
  // The DB flip is the load-bearing effect (it removes the kit from active
  // surfacing); a failed Drive move only leaves the Doc in place, not active.
  markKitArchived(db, kit.id);
}

/** Archive all active kits for an application (the symmetric terminal-transition path). */
export async function archiveKitsForApplication(db: Database.Database, applicationId: string): Promise<number> {
  const kits = getActiveKitsForApplication(db, applicationId);
  if (kits.length === 0) return 0;
  const folderId = getConfig<string>(db, 'interview_kit_drive_folder_id', '');
  const archiveId = getConfig<string>(db, 'interview_kit_drive_archive_folder_id', '');
  let archived = 0;
  for (const kit of kits) {
    try {
      await archiveOneKit(db, kit, folderId, archiveId);
      archived++;
    } catch (err) {
      log.error('archiveKitsForApplication: one kit failed', { kitId: kit.id, err });
    }
  }
  if (archived > 0) {
    log.info('interview-kit: archived kits for application', { applicationId, count: archived });
    // §24.65: the archived status is public metadata — re-project.
    await upsertPublicKitView(db, applicationId);
    upsertPublicFunnelView(db, applicationId);
  }
  return archived;
}

/** Backstop sweep: archive active kits whose application is terminal or ghosted past the threshold. */
export async function runKitCleanupSweep(db: Database.Database): Promise<{ archived: number }> {
  const staleDays = getConfig<number>(db, 'interview_kit_stale_days', 21);
  const staleBefore = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  const kits = findKitsToArchive(db, staleBefore);
  if (kits.length === 0) return { archived: 0 };
  const folderId = getConfig<string>(db, 'interview_kit_drive_folder_id', '');
  const archiveId = getConfig<string>(db, 'interview_kit_drive_archive_folder_id', '');
  let archived = 0;
  const touchedApps = new Set<string>();
  for (const kit of kits) {
    try {
      await archiveOneKit(db, kit, folderId, archiveId);
      archived++;
      touchedApps.add(kit.application_id);
    } catch (err) {
      log.error('runKitCleanupSweep: one kit failed', { kitId: kit.id, err });
    }
  }
  // §24.65: re-project each touched application (archived status is public metadata).
  for (const appId of touchedApps) {
    await upsertPublicKitView(db, appId);
    upsertPublicFunnelView(db, appId);
  }
  log.info('interview-kit cleanup sweep', { archived, threshold_days: staleDays });
  return { archived };
}
