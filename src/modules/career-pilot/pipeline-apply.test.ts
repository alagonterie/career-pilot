import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { applyPipelineFromEmailEvents } from './pipeline-apply.js';

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

function seedApp(id: string, status = 'APPLIED'): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (?, ?, ?, 'obfuscated', 'Engineer', ?, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(id, `Co ${id}`, `ai-${id}`, status);
}

let evtSeq = 0;
function seedEvent(app: string | null, classification: string, receivedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO email_events
         (gmail_msg_id, thread_id, classification, confidence, linked_application_id, received_at, classified_at, classified_by_run_id)
       VALUES (?, ?, ?, 0.9, ?, ?, datetime('now'), 'run-1')`,
    )
    .run(`m-${evtSeq++}`, `t-${app ?? 'x'}`, classification, app, receivedAt);
}

const statusOf = (id: string) =>
  (getDb().prepare('SELECT status FROM applications WHERE id = ?').get(id) as { status: string }).status;
const viewOf = (id: string) =>
  getDb().prepare('SELECT status, stage FROM public_pipeline_view WHERE application_id = ?').get(id) as
    | { status: string; stage: string }
    | undefined;

describe('applyPipelineFromEmailEvents', () => {
  it('converges each application to its furthest classification + projects the board', () => {
    seedApp('a-offer', 'APPLIED');
    seedApp('a-onsite', 'APPLIED');
    seedApp('a-reject', 'SCREENING');
    seedApp('a-noise', 'APPLIED');

    // offer thread: confirmation → screen → onsite → offer (offer is latest)
    seedEvent('a-offer', 'application_confirmation', '2026-05-01T00:00:00Z');
    seedEvent('a-offer', 'screen_invite', '2026-05-05T00:00:00Z');
    seedEvent('a-offer', 'onsite_invite', '2026-05-10T00:00:00Z');
    seedEvent('a-offer', 'offer', '2026-05-15T00:00:00Z');
    // onsite thread: confirmation → onsite, then a LATER noise (must be ignored)
    seedEvent('a-onsite', 'application_confirmation', '2026-05-01T00:00:00Z');
    seedEvent('a-onsite', 'onsite_invite', '2026-05-08T00:00:00Z');
    seedEvent('a-onsite', 'noise', '2026-05-09T00:00:00Z');
    // reject thread: screen → rejection (rejection is latest → REJECTED)
    seedEvent('a-reject', 'screen_invite', '2026-05-02T00:00:00Z');
    seedEvent('a-reject', 'rejection', '2026-05-06T00:00:00Z');
    // noise-only: no mapped classification → untouched
    seedEvent('a-noise', 'noise', '2026-05-03T00:00:00Z');

    const res = applyPipelineFromEmailEvents(getDb());

    expect(statusOf('a-offer')).toBe('OFFER');
    expect(statusOf('a-onsite')).toBe('TECH_SCREEN'); // the onsite, not the trailing noise
    expect(statusOf('a-reject')).toBe('REJECTED');
    expect(statusOf('a-noise')).toBe('APPLIED'); // unchanged

    expect(viewOf('a-offer')).toMatchObject({ status: 'OFFER', stage: 'offer' });
    expect(viewOf('a-onsite')).toMatchObject({ status: 'TECH_SCREEN', stage: 'tech' });
    expect(viewOf('a-reject')).toMatchObject({ status: 'REJECTED', stage: 'rejected' });

    expect(res.converted).toBe(3); // offer, onsite, reject changed; noise-only untouched
  });

  it('is idempotent — a second run makes no further changes', () => {
    seedApp('a1', 'APPLIED');
    seedEvent('a1', 'offer', '2026-05-15T00:00:00Z');
    expect(applyPipelineFromEmailEvents(getDb()).converted).toBe(1);
    expect(applyPipelineFromEmailEvents(getDb()).converted).toBe(0); // already OFFER
  });

  it('ignores email_events with no linked application', () => {
    seedApp('a1', 'APPLIED');
    seedEvent(null, 'offer', '2026-05-15T00:00:00Z'); // unlinked (e.g. a lead, not an application)
    expect(applyPipelineFromEmailEvents(getDb()).converted).toBe(0);
  });
});
