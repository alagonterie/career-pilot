import fs from 'fs';
import os from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { prepareResume } from './standby.js';

/**
 * §24.189 D8 — resume hygiene. After a long standby every recurring series has one
 * far-overdue pending row; resuming without rescheduling fires them all at once
 * (a "good morning" briefing at 3pm). These lock the roll-forward behavior.
 */
describe('prepareResume (§24.189 standby resume hygiene)', () => {
  // `messages_in` lives in the per-session INBOUND db, not the central v2.db —
  // so the fixture is a real inbound schema, the same one the sweep reads.
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-standby-'));
    const dbPath = path.join(dir, 'inbound.db');
    ensureSchema(dbPath, 'inbound');
    db = openInboundDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedMessage(over: {
    id: string;
    processAfter: string | null;
    recurrence?: string | null;
    status?: string;
  }): void {
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, content, series_id)
       VALUES (@id, @seq, @ts, @status, 0, @processAfter, @recurrence, 'task', '{"prompt":"x"}', @id)`,
    ).run({
      id: over.id,
      seq: Math.floor(Math.random() * 1_000_000) * 2,
      ts: '2026-06-01T00:00:00.000Z',
      status: over.status ?? 'pending',
      processAfter: over.processAfter,
      recurrence: over.recurrence ?? null,
    });
  }

  function processAfterOf(id: string): string | null {
    return (
      db.prepare('SELECT process_after FROM messages_in WHERE id = ?').get(id) as { process_after: string | null }
    ).process_after;
  }

  const NOW = new Date('2026-08-07T18:00:00.000Z'); // mid-afternoon, two months on

  it('rolls a far-overdue recurring row forward to its NEXT occurrence, not its missed one', async () => {
    // A daily briefing whose pending occurrence was two months ago.
    seedMessage({ id: 'briefing', processAfter: '2026-06-07T12:00:00.000Z', recurrence: '0 7 * * *' });

    const out = await prepareResume(db, NOW);
    expect(out.rescheduled).toBe(1);

    const next = processAfterOf('briefing');
    expect(next).not.toBeNull();
    // The whole point: it is now in the FUTURE, so resuming doesn't fire it.
    expect(Date.parse(next as string)).toBeGreaterThan(NOW.getTime());
    // …and it's the next occurrence, within a day — not two months of catch-up.
    expect(Date.parse(next as string) - NOW.getTime()).toBeLessThanOrEqual(86_400_000);
  });

  it('leaves rows that are not yet due untouched', async () => {
    const future = '2026-08-09T12:00:00.000Z';
    seedMessage({ id: 'later', processAfter: future, recurrence: '0 7 * * *' });

    const out = await prepareResume(db, NOW);
    expect(out.rescheduled).toBe(0);
    expect(processAfterOf('later')).toBe(future);
  });

  it('leaves an overdue ONE-SHOT alone and reports it (never silently drops owner intent)', async () => {
    seedMessage({ id: 'once', processAfter: '2026-06-07T12:00:00.000Z', recurrence: null });

    const out = await prepareResume(db, NOW);
    expect(out).toMatchObject({ rescheduled: 0, oneShotsLeft: 1 });
    expect(processAfterOf('once')).toBe('2026-06-07T12:00:00.000Z');
  });

  it('leaves a row with an unparseable cron due rather than dropping it', async () => {
    seedMessage({ id: 'broken', processAfter: '2026-06-07T12:00:00.000Z', recurrence: 'not-a-cron' });

    const out = await prepareResume(db, NOW);
    expect(out).toMatchObject({ rescheduled: 0, unparseable: 1 });
    expect(processAfterOf('broken')).toBe('2026-06-07T12:00:00.000Z');
  });

  it('ignores rows that are not pending', async () => {
    seedMessage({
      id: 'done',
      processAfter: '2026-06-07T12:00:00.000Z',
      recurrence: '0 7 * * *',
      status: 'completed',
    });

    expect(await prepareResume(db, NOW)).toMatchObject({ rescheduled: 0, oneShotsLeft: 0, unparseable: 0 });
    expect(processAfterOf('done')).toBe('2026-06-07T12:00:00.000Z');
  });

  it('handles a whole standby-shaped backlog in one pass', async () => {
    seedMessage({ id: 'briefing', processAfter: '2026-06-07T12:00:00.000Z', recurrence: '0 7 * * *' });
    seedMessage({ id: 'scrape', processAfter: '2026-06-07T10:00:00.000Z', recurrence: '0 5 * * *' });
    seedMessage({ id: 'scribe', processAfter: '2026-06-07T11:00:00.000Z', recurrence: '30 7 * * *' });
    seedMessage({ id: 'weekly', processAfter: '2026-06-07T09:00:00.000Z', recurrence: '0 9 * * 1' });

    const out = await prepareResume(db, NOW);
    expect(out.rescheduled).toBe(4);
    for (const id of ['briefing', 'scrape', 'scribe', 'weekly']) {
      expect(Date.parse(processAfterOf(id) as string)).toBeGreaterThan(NOW.getTime());
    }
  });
});
