import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  deriveInterviewType,
  findKitsToArchive,
  getActiveKitsForApplication,
  getActiveKitUrlsByApplication,
  getKitByApplicationRound,
  hasActiveKit,
  isInterviewRoundStatus,
  isTerminalStatus,
  markKitArchived,
  upsertInterviewKit,
} from './interview-kit-store.js';

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

function seedApp(id: string, status = 'APPLIED', lastActivityAt = "datetime('now')"): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (?, ?, ?, 'obfuscated', 'Engineer', ?, datetime('now'), ${lastActivityAt}, datetime('now'))`,
    )
    .run(id, `Co ${id}`, `ai-${id}`, status);
}

function upsert(
  appId: string,
  round: string,
  fileId = `file-${appId}-${round}`,
  url = `https://docs/${appId}/${round}`,
) {
  return upsertInterviewKit(getDb(), {
    application_id: appId,
    round,
    interview_type: deriveInterviewType(round),
    drive_file_id: fileId,
    drive_url: url,
    title: `Interview Kit — ${appId} — ${round}`,
  });
}

describe('interview-kit-store derivations', () => {
  it('classifies interview-bearing vs terminal vs other statuses', () => {
    for (const s of ['SCREENING', 'TECH_SCREEN', 'SYS_DESIGN', 'FINAL']) {
      expect(isInterviewRoundStatus(s)).toBe(true);
      expect(isTerminalStatus(s)).toBe(false);
    }
    for (const s of ['OFFER', 'REJECTED', 'WITHDRAWN']) {
      expect(isTerminalStatus(s)).toBe(true);
      expect(isInterviewRoundStatus(s)).toBe(false);
    }
    for (const s of ['BOOKMARKED', 'APPLIED', '', null, undefined]) {
      expect(isInterviewRoundStatus(s)).toBe(false);
      expect(isTerminalStatus(s)).toBe(false);
    }
    expect(isInterviewRoundStatus('tech_screen')).toBe(true); // case-insensitive
  });

  it('derives interview_type from each round, defaulting for unknowns', () => {
    expect(deriveInterviewType('SCREENING')).toBe('recruiter_screen');
    expect(deriveInterviewType('TECH_SCREEN')).toBe('technical_screen');
    expect(deriveInterviewType('SYS_DESIGN')).toBe('system_design');
    expect(deriveInterviewType('FINAL')).toBe('final_round');
    expect(deriveInterviewType('final')).toBe('final_round'); // case-insensitive
    expect(deriveInterviewType('APPLIED')).toBe('recruiter_screen'); // fallback
  });
});

describe('interview-kit-store CRUD', () => {
  it('inserts then reads back a kit; normalizes round to upper-case', () => {
    seedApp('a1');
    const id = upsert('a1', 'tech_screen');
    expect(id).toMatch(/^kit-/);
    const row = getKitByApplicationRound(getDb(), 'a1', 'TECH_SCREEN');
    expect(row?.id).toBe(id);
    expect(row?.round).toBe('TECH_SCREEN');
    expect(row?.interview_type).toBe('technical_screen');
    expect(row?.status).toBe('active');
    expect(row?.archived_at).toBeNull();
  });

  it('is idempotent on (application_id, round): a re-run updates in place, keeping one row + id', () => {
    seedApp('a1');
    const first = upsert('a1', 'TECH_SCREEN', 'file-v1', 'https://docs/v1');
    const second = upsert('a1', 'TECH_SCREEN', 'file-v2', 'https://docs/v2');
    expect(second).toBe(first); // same id
    const rows = getDb().prepare("SELECT * FROM interview_kits WHERE application_id = 'a1'").all();
    expect(rows).toHaveLength(1);
    const row = getKitByApplicationRound(getDb(), 'a1', 'TECH_SCREEN');
    expect(row?.drive_file_id).toBe('file-v2'); // updated content
    expect(row?.drive_url).toBe('https://docs/v2');
  });

  it('keeps separate kits per round for the same application', () => {
    seedApp('a1');
    upsert('a1', 'SCREENING');
    upsert('a1', 'TECH_SCREEN');
    expect(getActiveKitsForApplication(getDb(), 'a1')).toHaveLength(2);
  });

  it('hasActiveKit reflects active vs archived', () => {
    seedApp('a1');
    const id = upsert('a1', 'FINAL');
    expect(hasActiveKit(getDb(), 'a1', 'FINAL')).toBe(true);
    markKitArchived(getDb(), id, '2026-06-08T00:00:00Z');
    expect(hasActiveKit(getDb(), 'a1', 'FINAL')).toBe(false);
  });

  it('archives a kit, then re-activates it on a fresh upsert (manual refresh)', () => {
    seedApp('a1');
    const id = upsert('a1', 'FINAL', 'file-old');
    markKitArchived(getDb(), id, '2026-06-08T00:00:00Z');
    let row = getKitByApplicationRound(getDb(), 'a1', 'FINAL');
    expect(row?.status).toBe('archived');
    expect(row?.archived_at).toBe('2026-06-08T00:00:00Z');

    const id2 = upsert('a1', 'FINAL', 'file-new');
    expect(id2).toBe(id); // same row id
    row = getKitByApplicationRound(getDb(), 'a1', 'FINAL');
    expect(row?.status).toBe('active');
    expect(row?.archived_at).toBeNull();
    expect(row?.drive_file_id).toBe('file-new');
  });
});

describe('getActiveKitUrlsByApplication (read_pipeline_state join)', () => {
  it('returns the newest active kit_url per requested application, ignoring archived + unrequested', () => {
    seedApp('a1');
    seedApp('a2');
    seedApp('a3');
    upsert('a1', 'SCREENING', 'f1', 'https://docs/a1-screen');
    upsert('a1', 'TECH_SCREEN', 'f2', 'https://docs/a1-tech'); // newer for a1
    const archivedId = upsert('a2', 'FINAL', 'f3', 'https://docs/a2-final');
    markKitArchived(getDb(), archivedId, '2026-06-08T00:00:00Z'); // a2 has no active kit

    const map = getActiveKitUrlsByApplication(getDb(), ['a1', 'a2', 'a3']);
    expect(map.get('a1')).toBe('https://docs/a1-tech');
    expect(map.has('a2')).toBe(false); // only archived
    expect(map.has('a3')).toBe(false); // no kit
  });

  it('returns an empty map for empty input', () => {
    expect(getActiveKitUrlsByApplication(getDb(), []).size).toBe(0);
  });
});

describe('findKitsToArchive (backstop sweep)', () => {
  it('returns active kits whose application is terminal OR ghosted past the threshold; spares active+recent', () => {
    seedApp('a-terminal', 'REJECTED');
    seedApp('a-ghost', 'TECH_SCREEN', "'2026-01-01T00:00:00Z'"); // last activity long ago
    seedApp('a-recent', 'TECH_SCREEN', "'2026-06-08T00:00:00Z'"); // fresh
    upsert('a-terminal', 'TECH_SCREEN');
    upsert('a-ghost', 'TECH_SCREEN');
    upsert('a-recent', 'TECH_SCREEN');

    const stale = findKitsToArchive(getDb(), '2026-05-01T00:00:00Z');
    const apps = stale.map((k) => k.application_id).sort();
    expect(apps).toEqual(['a-ghost', 'a-terminal']);
  });

  it('excludes already-archived kits', () => {
    seedApp('a-terminal', 'REJECTED');
    const id = upsert('a-terminal', 'FINAL');
    markKitArchived(getDb(), id);
    expect(findKitsToArchive(getDb(), '2026-05-01T00:00:00Z')).toHaveLength(0);
  });
});
