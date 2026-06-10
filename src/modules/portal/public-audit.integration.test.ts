/**
 * Integration tests for the Phase 4 §24.10 mirror writer.
 *
 * Exercises the load → sanitize → defense-in-depth → INSERT path against
 * a fresh in-memory central DB. Does not spawn a container; does not
 * touch the action handler — that's covered by the spot-check in
 * actions.integration.test.ts (Component 3).
 *
 * mirrorFunnelEvent + resanitizeApplicationAuditTrail are async since §24.12
 * (Pass 3). In this test env Pass 3 is inactive (no Portkey key + the default
 * `sanitization_pass3_enabled=false`), so the deterministic Pass 1+2 path runs
 * and the outcomes/values are unchanged — the calls just need awaiting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { mirrorFunnelEvent, publicApplicationRef, resanitizeApplicationAuditTrail } from './public-audit.js';

describe('mirrorFunnelEvent', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  function seedApp(opts: {
    id: string;
    company_name: string;
    company_aliases?: string | null;
    obfuscated_label: string;
    public_state?: string;
  }): void {
    db.prepare(
      `INSERT INTO applications (
         id, company_name, company_aliases, obfuscated_label, public_state,
         role_title, status, created_at
       ) VALUES (
         @id, @company_name, @company_aliases, @obfuscated_label, @public_state,
         'Senior Engineer', 'BOOKMARKED', '2026-05-28T00:00:00Z'
       )`,
    ).run({
      id: opts.id,
      company_name: opts.company_name,
      company_aliases: opts.company_aliases ?? null,
      obfuscated_label: opts.obfuscated_label,
      public_state: opts.public_state ?? 'obfuscated',
    });
  }

  function seedEvent(opts: {
    id: string;
    application_id: string;
    kind?: string;
    from_status?: string | null;
    to_status?: string | null;
    payload?: string;
  }): void {
    db.prepare(
      `INSERT INTO funnel_events (
         id, application_id, kind, from_status, to_status, payload, source, ts
       ) VALUES (
         @id, @application_id, @kind, @from_status, @to_status, @payload,
         'agent', '2026-05-28T00:00:00Z'
       )`,
    ).run({
      id: opts.id,
      application_id: opts.application_id,
      kind: opts.kind ?? 'status_change',
      from_status: opts.from_status ?? null,
      to_status: opts.to_status ?? null,
      payload: opts.payload ?? '{}',
    });
  }

  function readAuditRows(): Array<{
    application_ref: string | null;
    summary: string;
    category: string;
    details_json: string | null;
  }> {
    return db
      .prepare('SELECT application_ref, summary, category, details_json FROM public_audit_trail')
      .all() as Array<{
      application_ref: string | null;
      summary: string;
      category: string;
      details_json: string | null;
    }>;
  }

  it('mirrors a happy-path obfuscated event with PII redacted + company replaced', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    seedEvent({
      id: 'fe-1',
      application_id: 'app-1',
      kind: 'recruiter_email',
      payload: JSON.stringify({ note: 'jane@acme.com sent the $220k offer at Acme Corp' }),
    });

    await mirrorFunnelEvent(db, 'fe-1');

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].application_ref).toBe('fintech-a');
    expect(rows[0].category).toBe('funnel');
    expect(rows[0].summary).toContain('[REDACTED:fintech-a]');
    expect(rows[0].summary).toContain('[EMAIL_REDACTED]');
    expect(rows[0].summary).toContain('[AMOUNT_REDACTED]');
    expect(rows[0].summary).not.toContain('Acme Corp');
    expect(rows[0].summary).not.toContain('jane@acme.com');
    expect(rows[0].summary).not.toContain('$220k');
  });

  it('writes the real company name when public_state=public', async () => {
    seedApp({
      id: 'app-1',
      company_name: 'Acme Corp',
      obfuscated_label: 'fintech-a',
      public_state: 'public',
    });
    seedEvent({
      id: 'fe-1',
      application_id: 'app-1',
      payload: JSON.stringify({ note: 'great chat with Acme Corp' }),
    });

    await mirrorFunnelEvent(db, 'fe-1');

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].application_ref).toBe('Acme Corp');
    expect(rows[0].summary).toContain('Acme Corp'); // not redacted
  });

  it('skips events whose application is missing (defensive on FK gap)', async () => {
    // Insert an event referencing a non-existent application. The FK
    // constraint should prevent this in normal use; we bypass via raw SQL
    // to simulate a stale FK.
    db.exec('PRAGMA foreign_keys = OFF');
    seedEvent({ id: 'fe-1', application_id: 'app-missing' });
    db.exec('PRAGMA foreign_keys = ON');

    await mirrorFunnelEvent(db, 'fe-1');

    expect(readAuditRows()).toHaveLength(0);
  });

  it('drops the row when the defense-in-depth scan finds a surviving real name', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    // Seed a SECOND non-public company whose name will appear in the
    // payload but is NOT linked to this event's application. Pass 2
    // SHOULD redact it (it scans all non-public apps). To force a leak
    // for the test, name the second company something Pass 2 would miss
    // via word-boundary semantics — a lowercased alias-only company
    // where neither company_name nor company_aliases matches.
    //
    // Cleanest path: directly seed an unmatched scenario by inserting a
    // public_audit_trail row with leak-prone text bypassed sanitize. We
    // instead force the leak by stashing a substring of the event
    // payload as another app's company_name that DIDN'T get replaced
    // because the payload uses a stylistic variant.
    //
    // Simulate by seeding a second non-public app whose company_name
    // matches a substring that Pass 2 didn't redact (e.g., a misspelling
    // in the payload).
    seedApp({ id: 'app-2', company_name: 'PartnerCo', obfuscated_label: 'consulting-a' });
    seedEvent({
      id: 'fe-1',
      application_id: 'app-1',
      payload: JSON.stringify({ note: 'collaboration with PartnerCo announced' }),
    });

    // Sanity check: this payload should round-trip with PartnerCo
    // REDACTED by Pass 2 normally. Let's verify the dropped-by-default
    // path instead works by manually corrupting Pass 2's view — set
    // PartnerCo's obfuscated_label to empty so Pass 2 skips it.
    db.prepare("UPDATE applications SET obfuscated_label = '' WHERE id = 'app-2'").run();

    await mirrorFunnelEvent(db, 'fe-1');

    // PartnerCo survived sanitization → defense-in-depth dropped the row.
    expect(readAuditRows()).toHaveLength(0);
  });

  it('writes the row when the operator disables defense-in-depth', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    seedApp({ id: 'app-2', company_name: 'PartnerCo', obfuscated_label: '' });
    seedEvent({
      id: 'fe-1',
      application_id: 'app-1',
      payload: JSON.stringify({ note: 'collaboration with PartnerCo announced' }),
    });

    // Operator override: allow rows through even when defense-in-depth
    // detects a leak.
    db.prepare(
      `INSERT INTO preferences (key, value, updated_at)
       VALUES ('sanitization_audit_drop_on_unmatched_company', 'false', '2026-05-28T00:00:00Z')`,
    ).run();

    await mirrorFunnelEvent(db, 'fe-1');

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    // PartnerCo leaked through (this is the OPERATOR override case).
    expect(rows[0].summary).toContain('PartnerCo');
  });

  it('truncates summary to the configured max_chars preference', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a' });
    const longPayload = 'x'.repeat(2000);
    seedEvent({ id: 'fe-1', application_id: 'app-1', payload: longPayload });

    db.prepare(
      `INSERT INTO preferences (key, value, updated_at)
       VALUES ('sanitization_public_summary_max_chars', '100', '2026-05-28T00:00:00Z')`,
    ).run();

    await mirrorFunnelEvent(db, 'fe-1');

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].summary.length).toBe(100);
  });

  it('uses default 500-char truncation when no preference is set', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a' });
    const longPayload = 'x'.repeat(2000);
    seedEvent({ id: 'fe-1', application_id: 'app-1', payload: longPayload });

    await mirrorFunnelEvent(db, 'fe-1');

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].summary.length).toBe(500);
  });

  it('includes details_json with the kind + status arrows + sanitized text', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a' });
    seedEvent({
      id: 'fe-1',
      application_id: 'app-1',
      kind: 'status_change',
      from_status: 'BOOKMARKED',
      to_status: 'APPLIED',
      payload: JSON.stringify({ note: 'submitted via Greenhouse' }),
    });

    await mirrorFunnelEvent(db, 'fe-1');

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].details_json).not.toBeNull();
    const details = JSON.parse(rows[0].details_json!);
    expect(details.kind).toBe('status_change');
    expect(details.from_status).toBe('BOOKMARKED');
    expect(details.to_status).toBe('APPLIED');
    expect(typeof details.sanitized).toBe('string');
  });

  it('does not throw (resolves) if the funnel_event id does not exist', async () => {
    await expect(mirrorFunnelEvent(db, 'fe-nonexistent')).resolves.toBe('skipped');
    expect(readAuditRows()).toHaveLength(0);
  });

  it('links the audit row back to its source funnel_event (§24.11 migration 122)', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    seedEvent({ id: 'fe-1', application_id: 'app-1', payload: JSON.stringify({ note: 'hello' }) });

    const outcome = await mirrorFunnelEvent(db, 'fe-1');
    expect(outcome).toBe('inserted');

    const row = db.prepare('SELECT source_funnel_event_id FROM public_audit_trail').get() as {
      source_funnel_event_id: string | null;
    };
    expect(row.source_funnel_event_id).toBe('fe-1');
  });

  it('returns a typed outcome for skipped/dropped paths', async () => {
    // Non-existent event → skipped.
    expect(await mirrorFunnelEvent(db, 'fe-nope')).toBe('skipped');

    // Defense-in-depth drop → dropped.
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    seedApp({ id: 'app-2', company_name: 'PartnerCo', obfuscated_label: '' });
    seedEvent({
      id: 'fe-1',
      application_id: 'app-1',
      payload: JSON.stringify({ note: 'collaboration with PartnerCo announced' }),
    });
    expect(await mirrorFunnelEvent(db, 'fe-1')).toBe('dropped');
  });

  // ── §24.61: host-side public-ref derivation ─────────────────────────────
  describe('publicApplicationRef', () => {
    it('returns the obfuscated label for a non-public application', () => {
      seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
      expect(publicApplicationRef(db, 'app-1')).toBe('fintech-a');
    });

    it('returns the real company name for a public application', () => {
      seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a', public_state: 'public' });
      expect(publicApplicationRef(db, 'app-1')).toBe('Acme Corp');
    });

    it('returns null for an unknown id or a label-less application', () => {
      expect(publicApplicationRef(db, 'app-nope')).toBeNull();
      seedApp({ id: 'app-2', company_name: 'Globex', obfuscated_label: '' });
      expect(publicApplicationRef(db, 'app-2')).toBeNull();
    });
  });

  // ── §24.11 Sub-milestone 4.3: retroactive resanitization ───────────────
  describe('resanitizeApplicationAuditTrail', () => {
    it('rewrites public→obfuscated: real name replaced with [REDACTED:<label>]', async () => {
      seedApp({
        id: 'app-1',
        company_name: 'Acme Corp',
        obfuscated_label: 'fintech-a',
        public_state: 'public',
      });
      seedEvent({
        id: 'fe-1',
        application_id: 'app-1',
        payload: JSON.stringify({ note: 'call with Acme Corp went well' }),
      });
      expect(await mirrorFunnelEvent(db, 'fe-1')).toBe('inserted');

      // Baseline: public row shows the real name.
      let rows = readAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].application_ref).toBe('Acme Corp');
      expect(rows[0].summary).toContain('Acme Corp');

      db.prepare("UPDATE applications SET public_state = 'obfuscated' WHERE id = 'app-1'").run();
      expect(await resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 1, deleted: 1 });

      rows = readAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].application_ref).toBe('fintech-a');
      expect(rows[0].summary).toContain('[REDACTED:fintech-a]');
      expect(rows[0].summary).not.toContain('Acme Corp');
    });

    it('rewrites obfuscated→public: [REDACTED:<label>] replaced with the real name', async () => {
      seedApp({
        id: 'app-1',
        company_name: 'Acme Corp',
        obfuscated_label: 'fintech-a',
        public_state: 'obfuscated',
      });
      seedEvent({
        id: 'fe-1',
        application_id: 'app-1',
        payload: JSON.stringify({ note: 'call with Acme Corp went well' }),
      });
      expect(await mirrorFunnelEvent(db, 'fe-1')).toBe('inserted');

      let rows = readAuditRows();
      expect(rows[0].summary).toContain('[REDACTED:fintech-a]');
      expect(rows[0].summary).not.toContain('Acme Corp');

      db.prepare("UPDATE applications SET public_state = 'public' WHERE id = 'app-1'").run();
      expect(await resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 1, deleted: 1 });

      rows = readAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].application_ref).toBe('Acme Corp');
      expect(rows[0].summary).toContain('Acme Corp');
      expect(rows[0].summary).not.toContain('[REDACTED:fintech-a]');
    });

    it('rewrites after an obfuscated_label change: rows reflect the new label', async () => {
      seedApp({
        id: 'app-1',
        company_name: 'Acme Corp',
        obfuscated_label: 'fintech-a',
        public_state: 'obfuscated',
      });
      seedEvent({
        id: 'fe-1',
        application_id: 'app-1',
        payload: JSON.stringify({ note: 'spoke with Acme Corp' }),
      });
      expect(await mirrorFunnelEvent(db, 'fe-1')).toBe('inserted');

      db.prepare("UPDATE applications SET obfuscated_label = 'fintech-z' WHERE id = 'app-1'").run();
      expect(await resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 1, deleted: 1 });

      const rows = readAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].application_ref).toBe('fintech-z');
      expect(rows[0].summary).toContain('[REDACTED:fintech-z]');
      expect(rows[0].summary).not.toContain('fintech-a');
    });

    it('rewrites after a company_aliases add: the new alias is now redacted', async () => {
      seedApp({
        id: 'app-1',
        company_name: 'Acme Corp',
        obfuscated_label: 'fintech-a',
        public_state: 'obfuscated',
      });
      // Payload mentions only the alias, not the canonical name.
      seedEvent({
        id: 'fe-1',
        application_id: 'app-1',
        payload: JSON.stringify({ note: 'AcmeCo recruiter reached out' }),
      });
      expect(await mirrorFunnelEvent(db, 'fe-1')).toBe('inserted');

      // Baseline: alias not yet known → leaks through.
      let rows = readAuditRows();
      expect(rows[0].summary).toContain('AcmeCo');

      db.prepare(`UPDATE applications SET company_aliases = '["AcmeCo"]' WHERE id = 'app-1'`).run();
      expect(await resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 1, deleted: 1 });

      rows = readAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toContain('[REDACTED:fintech-a]');
      expect(rows[0].summary).not.toContain('AcmeCo');
    });

    it('is a no-op when the application has no funnel_events', async () => {
      seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
      expect(await resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 0, deleted: 0 });
      expect(readAuditRows()).toHaveLength(0);
    });

    // ── §24.61: subagent_progress rows attribute via details_json's
    // application_id; their ref is re-derived in place on a policy flip.
    function seedProgressRow(opts: { id: string; application_id?: string; application_ref: string | null }): void {
      db.prepare(
        `INSERT INTO public_audit_trail (id, seq, ts, category, agent_name, proactive, application_ref, summary, details_json)
         VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_audit_trail),
                 '2026-05-28T00:00:00Z', 'subagent_progress', 'tailor-resume', 0, @application_ref, 'ranking bullets', @details_json)`,
      ).run({
        id: opts.id,
        application_ref: opts.application_ref,
        details_json: JSON.stringify({
          stage: 'ranking-bullets',
          session_id: 's-1',
          ...(opts.application_id ? { application_id: opts.application_id } : {}),
        }),
      });
    }

    it('re-derives progress refs on a reveal AND an un-reveal (§24.61)', async () => {
      seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a', public_state: 'obfuscated' });
      seedProgressRow({ id: 'prog-1', application_id: 'app-1', application_ref: 'fintech-a' });

      // Reveal: the progress ref becomes the real name.
      db.prepare("UPDATE applications SET public_state = 'public' WHERE id = 'app-1'").run();
      await resanitizeApplicationAuditTrail(db, 'app-1');
      let row = db.prepare("SELECT application_ref FROM public_audit_trail WHERE id = 'prog-1'").get() as {
        application_ref: string | null;
      };
      expect(row.application_ref).toBe('Acme Corp');

      // Un-reveal (the dangerous direction): the stored real name reverts to
      // the obfuscated label.
      db.prepare("UPDATE applications SET public_state = 'obfuscated' WHERE id = 'app-1'").run();
      await resanitizeApplicationAuditTrail(db, 'app-1');
      row = db.prepare("SELECT application_ref FROM public_audit_trail WHERE id = 'prog-1'").get() as {
        application_ref: string | null;
      };
      expect(row.application_ref).toBe('fintech-a');
    });

    it('re-derives progress refs on a label rename; unrelated progress rows untouched (§24.61)', async () => {
      seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a', public_state: 'obfuscated' });
      seedApp({ id: 'app-2', company_name: 'Globex', obfuscated_label: 'retail-a', public_state: 'obfuscated' });
      seedProgressRow({ id: 'prog-1', application_id: 'app-1', application_ref: 'fintech-a' });
      seedProgressRow({ id: 'prog-2', application_id: 'app-2', application_ref: 'retail-a' });
      seedProgressRow({ id: 'prog-3', application_ref: null }); // unattributed — never touched

      db.prepare("UPDATE applications SET obfuscated_label = 'fintech-z' WHERE id = 'app-1'").run();
      await resanitizeApplicationAuditTrail(db, 'app-1');

      const refs = db
        .prepare("SELECT id, application_ref FROM public_audit_trail WHERE category = 'subagent_progress'")
        .all() as Array<{ id: string; application_ref: string | null }>;
      const byId = Object.fromEntries(refs.map((r) => [r.id, r.application_ref]));
      expect(byId['prog-1']).toBe('fintech-z');
      expect(byId['prog-2']).toBe('retail-a');
      expect(byId['prog-3']).toBeNull();
    });

    it('rewrites only the target application; counts match and other rows are untouched', async () => {
      seedApp({
        id: 'app-1',
        company_name: 'Acme Corp',
        obfuscated_label: 'fintech-a',
        public_state: 'obfuscated',
      });
      // A second, unrelated app whose audit rows must NOT be touched.
      seedApp({
        id: 'app-2',
        company_name: 'Globex',
        obfuscated_label: 'retail-a',
        public_state: 'obfuscated',
      });

      seedEvent({ id: 'fe-1', application_id: 'app-1', payload: JSON.stringify({ note: 'first with Acme Corp' }) });
      seedEvent({ id: 'fe-2', application_id: 'app-1', payload: JSON.stringify({ note: 'second with Acme Corp' }) });
      seedEvent({ id: 'fe-3', application_id: 'app-1', payload: JSON.stringify({ note: 'third with Acme Corp' }) });
      seedEvent({ id: 'fe-x', application_id: 'app-2', payload: JSON.stringify({ note: 'unrelated Globex note' }) });

      for (const id of ['fe-1', 'fe-2', 'fe-3', 'fe-x']) {
        expect(await mirrorFunnelEvent(db, id)).toBe('inserted');
      }

      db.prepare("UPDATE applications SET public_state = 'public' WHERE id = 'app-1'").run();
      expect(await resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 3, deleted: 3 });

      // app-1 rows now public (real name); app-2 row untouched (still redacted).
      const app1Rows = db
        .prepare("SELECT summary FROM public_audit_trail WHERE application_ref = 'Acme Corp'")
        .all() as { summary: string }[];
      expect(app1Rows).toHaveLength(3);
      for (const r of app1Rows) expect(r.summary).toContain('Acme Corp');

      const app2Rows = db
        .prepare("SELECT summary FROM public_audit_trail WHERE application_ref = 'retail-a'")
        .all() as { summary: string }[];
      expect(app2Rows).toHaveLength(1);
      expect(app2Rows[0].summary).toContain('[REDACTED:retail-a]');
    });
  });
});
